/**
 * IPC handlers for Workspace Health audits.
 *
 * Bridges the renderer ↔ AuditAgentService, persists results to the DB,
 * and forwards streaming events to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC_CHANNELS, AUDIT_TRACKS, MCP_TOOLS } from '../../shared/constants'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditRun,
  LLMProvider
} from '../../shared/types'
import type { StreamChunk } from '../services/agent-base.service'
import { summarizeToolInput } from '../services/agent-base.service'
import { extractResultSummary, reportToolError } from './chat-shared'
import { auditRepository, conversationRepository, messageRepository } from '../db/repositories'
import { workspaceRepository } from '../db/repositories'
import { detectTechStack } from '../services/tech-stack-detector.service'
import {
  auditAgentService,
  type AuditProgressPayload,
  type AuditResultPayload,
  type AuditCompletePayload,
  type AuditIntermediateFindingsPayload
} from '../services/audit-agent.service'
import { validateSender } from './validate-sender'
import log from 'electron-log'

const auditLog = log.scope('audit-ipc')

export function registerAuditIpc(mainWindow: BrowserWindow): void {
  // ── audit:start — start a new audit run ─────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_START,
    async (
      event,
      args: {
        workspaceId: string
        mode: AuditMode
        tracks: AuditTrackId[]
        llmProvider?: LLMProvider
      }
    ): Promise<AuditRun> => {
      validateSender(event)

      const { workspaceId, mode, tracks, llmProvider: explicitProvider } = args

      if (auditAgentService.isRunning) {
        throw new Error('An audit is already running. Cancel it first.')
      }

      // Resolve workspace path
      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${workspaceId} has no repo path`)

      // Detect tech stack
      const techResult = detectTechStack(workspace.repoPath)
      const detectedTechs = techResult.detectedTechs

      // Resolve LLM provider: explicit selection → workspace setting → 'claude'
      const settings = workspaceRepository.getSettings(workspaceId)
      const llmProvider: LLMProvider = explicitProvider ?? settings.llmProvider ?? 'claude'

      // Create new run in DB (deletes previous for this workspace)
      const run = auditRepository.createRun(workspaceId, mode, tracks, detectedTechs)
      const results = auditRepository.createResults(run.id, tracks)
      run.results = results

      auditLog.info(
        `[audit:start] workspaceId=${workspaceId} mode=${mode} tracks=${tracks.join(',')} provider=${llmProvider} runId=${run.id}`
      )

      // Wire event forwarding: auditAgentService → renderer + DB
      wireAuditEvents(mainWindow, run.id, workspaceId, workspace.repoPath)

      // Start the audit (non-blocking — runs in background)
      auditAgentService
        .runAudit({
          workspaceId,
          workspacePath: workspace.repoPath,
          mode,
          selectedTracks: tracks,
          auditRunId: run.id,
          llmProvider
        })
        .catch((err) => {
          auditLog.error('[audit:start] runAudit failed:', err)
        })

      // Update run status to 'running'
      auditRepository.updateRun(run.id, { status: 'running' })
      run.status = 'running'

      return run
    }
  )

  // ── audit:cancel — abort running audit ──────────────────────────────

  ipcMain.handle(IPC_CHANNELS.AUDIT_CANCEL, (event): void => {
    validateSender(event)
    auditAgentService.cancel()
  })

  // ── audit:getLatest — load latest audit results ─────────────────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_GET_LATEST,
    (event, args: { workspaceId: string }): AuditRun | null => {
      validateSender(event)
      const run = auditRepository.getLatestForWorkspace(args.workspaceId)

      // Reconcile stale "running" state after app restart.
      // If the DB says the audit is running but the agent process isn't,
      // the previous run was interrupted — mark incomplete tracks as cancelled.
      if (run && run.status === 'running' && !auditAgentService.isRunning) {
        auditLog.warn(
          `[audit:getLatest] Stale running audit detected (runId=${run.id}) — reconciling`
        )

        for (const result of run.results) {
          if (result.status === 'running' || result.status === 'pending') {
            auditRepository.updateResult(result.id, { status: 'cancelled' })
            result.status = 'cancelled' as typeof result.status
          }
        }

        const hasCompleted = run.results.some((r) => r.status === 'completed')
        const finalStatus = hasCompleted ? 'partial' : 'cancelled'
        const updated = auditRepository.updateRun(run.id, {
          status: finalStatus as 'completed' | 'partial' | 'cancelled'
        })
        return updated ?? run
      }

      return run
    }
  )

  // ── audit:rerunTrack — re-run a single auditor ──────────────────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_RERUN_TRACK,
    async (
      event,
      args: { workspaceId: string; trackId: AuditTrackId; mode: AuditMode }
    ): Promise<void> => {
      validateSender(event)

      const { workspaceId, trackId, mode } = args

      if (auditAgentService.isRunning) {
        throw new Error('An audit is already running. Cancel it first.')
      }

      const workspace = workspaceRepository.findById(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${workspaceId} has no repo path`)

      // Find the latest run for this workspace
      const latestRun = auditRepository.getLatestForWorkspace(workspaceId)
      if (!latestRun) throw new Error('No audit run found for workspace')

      auditLog.info(`[audit:rerunTrack] trackId=${trackId} mode=${mode} runId=${latestRun.id}`)

      // Wire event forwarding for this single-track run
      wireAuditEvents(mainWindow, latestRun.id, workspaceId, workspace.repoPath)

      auditAgentService
        .runSingleTrack({
          workspaceId,
          workspacePath: workspace.repoPath,
          trackId,
          mode
        })
        .then(() => {
          // Recalculate overall score after single track re-run
          const results = auditRepository.findResultsByRunId(latestRun.id)
          const completed = results.filter((r) => r.status === 'completed' && r.score !== null)
          const hasFailed = results.some((r) => r.status === 'failed')

          let newOverall: number | null = null
          if (completed.length > 0) {
            let weightedSum = 0
            let totalWeight = 0
            for (const r of completed) {
              const w = AUDIT_TRACKS[r.trackId]?.weight ?? 1.0
              weightedSum += (r.score ?? 0) * w
              totalWeight += w
            }
            newOverall = Math.round(weightedSum / totalWeight)
          }

          // Update status — 'partial' if any track failed, 'completed' if all succeeded
          const newStatus = hasFailed ? 'partial' : 'completed'
          const updatedRun = auditRepository.updateRun(latestRun.id, {
            overallScore: newOverall ?? undefined,
            status: newStatus
          })
          if (updatedRun) {
            mainWindow.webContents.send(IPC_CHANNELS.AUDIT_COMPLETE, updatedRun)
          }
        })
        .catch((err) => {
          auditLog.error('[audit:rerunTrack] failed:', err)
        })
    }
  )

  // ── audit:resume — resume an interrupted audit (re-run only incomplete tracks) ──

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_RESUME,
    async (event, args: { workspaceId: string }): Promise<AuditRun | null> => {
      validateSender(event)

      if (auditAgentService.isRunning) {
        throw new Error('An audit is already running.')
      }

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error(`Workspace ${args.workspaceId} not found`)
      if (!workspace.repoPath) throw new Error(`Workspace ${args.workspaceId} has no repo path`)

      const run = auditRepository.getLatestForWorkspace(args.workspaceId)
      if (!run) throw new Error('No audit run found to resume')

      // Only tracks that didn't complete successfully are resumable
      const resumableTracks = run.results
        .filter((r) => r.status === 'cancelled' || r.status === 'pending' || r.status === 'failed')
        .map((r) => r.trackId)

      if (resumableTracks.length === 0) {
        throw new Error('All tracks are already completed — nothing to resume')
      }

      auditLog.info(
        `[audit:resume] runId=${run.id} resuming ${resumableTracks.length} tracks: ${resumableTracks.join(',')}`
      )

      // Reset resumable track results back to 'pending'
      for (const result of run.results) {
        if (resumableTracks.includes(result.trackId)) {
          auditRepository.updateResult(result.id, { status: 'pending' })
          result.status = 'pending' as typeof result.status
        }
      }

      // Update run status back to 'running'
      auditRepository.updateRun(run.id, { status: 'running' })
      run.status = 'running'

      // Wire events and start — same as audit:start but targeting only incomplete tracks
      wireAuditEvents(mainWindow, run.id, args.workspaceId, workspace.repoPath)

      auditAgentService
        .runAudit({
          workspaceId: args.workspaceId,
          workspacePath: workspace.repoPath,
          mode: run.mode,
          selectedTracks: resumableTracks,
          auditRunId: run.id
        })
        .catch((err) => {
          auditLog.error('[audit:resume] runAudit failed:', err)
        })

      return run
    }
  )

  // ── audit:convertFindings — create plan-mode conversation from findings

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_CONVERT_FINDINGS,
    (
      event,
      args: { workspaceId: string; findings: AuditFinding[] }
    ): { conversationId: string } => {
      validateSender(event)

      const { workspaceId, findings } = args

      // Read workspace LLM provider for conversation creation
      const wsSettings = workspaceRepository.getSettings(workspaceId)
      const llmProvider: LLMProvider = wsSettings.llmProvider ?? 'claude'

      // Create conversation in plan mode
      const title = `🔍 Audit: Fix ${findings.length} finding${findings.length > 1 ? 's' : ''}`
      const conv = conversationRepository.create(workspaceId, title, 'plan', undefined, llmProvider)

      // Build a structured first message with all findings as context
      const findingsContext = findings
        .map(
          (f, i) =>
            `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n${f.description}` +
            (f.filePath ? `\n**File:** \`${f.filePath}\`` : '') +
            (f.recommendation ? `\n**Recommendation:** ${f.recommendation}` : '')
        )
        .join('\n\n')

      const contextMessage = `The following audit findings need to be addressed:\n\n${findingsContext}\n\nPlease analyze these findings and propose a plan to fix them.`

      // Insert as first user message
      messageRepository.create(conv.id, 'user', contextMessage)

      auditLog.info(
        `[audit:convert] Created conversation ${conv.id} with ${findings.length} findings`
      )

      return { conversationId: conv.id }
    }
  )

  // ── audit:exportMarkdown — export latest audit as Markdown ─────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_EXPORT_MARKDOWN,
    async (event, args: { workspaceId: string }): Promise<void> => {
      validateSender(event)

      const run = auditRepository.getLatestForWorkspace(args.workspaceId)
      if (!run) throw new Error('No audit run found for this workspace')

      const workspace = workspaceRepository.findById(args.workspaceId)
      const workspaceName = workspace?.name ?? 'Unknown Workspace'

      // Build Markdown
      const date = new Date(run.createdAt).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })

      const lines: string[] = [
        `# Workspace Health Report`,
        `**Workspace:** ${workspaceName} | **Mode:** ${run.mode === 'light' ? 'Light' : 'Deep'} | **Date:** ${date} | **Overall Score:** ${run.overallScore ?? '—'}/100`,
        ''
      ]

      for (const trackId of run.selectedTracks) {
        const track = AUDIT_TRACKS[trackId]
        const result = run.results.find((r) => r.trackId === trackId)
        if (!track || !result) continue

        lines.push(`## ${track.name} — ${result.score ?? '—'}/100`)
        if (result.summary) {
          lines.push(result.summary)
        }
        lines.push('')

        if (result.findings.length > 0) {
          lines.push('### Findings')
          lines.push('| Severity | Title | File | Recommendation |')
          lines.push('|----------|-------|------|----------------|')
          for (const f of result.findings) {
            lines.push(
              `| ${f.severity.toUpperCase()} | ${f.title} | ${f.filePath ?? '—'} | ${f.recommendation ?? '—'} |`
            )
          }
          lines.push('')
        }
      }

      const markdown = lines.join('\n')

      // Show save dialog
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Audit Report',
        defaultPath: `health-report-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })

      if (canceled || !filePath) return

      await writeFile(filePath, markdown, 'utf-8')
      auditLog.info(`[audit:export] Exported to ${filePath}`)
    }
  )

  // ── audit:getHistory — get recent audit runs ──────────────────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }): AuditRun[] => {
      validateSender(event)
      return auditRepository.getHistoryForWorkspace(args.workspaceId, args.limit ?? 10)
    }
  )
}

// ── Event forwarding ─────────────────────────────────────────────────────

/**
 * Wire one-time event listeners for the current audit run.
 * Forwards progress/result/complete to the renderer and persists to DB.
 */
/** Per-workspace listener cleanup functions. */
const auditListenerCleanups = new Map<string, Array<() => void>>()

function wireAuditEvents(
  mainWindow: BrowserWindow,
  runId: string,
  workspaceId: string,
  workspacePath: string
): void {
  // Clean up stale listeners for THIS workspace only (not other workspaces)
  const existingCleanups = auditListenerCleanups.get(workspaceId)
  if (existingCleanups) {
    for (const cleanup of existingCleanups) cleanup()
  }
  const cleanups: Array<() => void> = []
  auditListenerCleanups.set(workspaceId, cleanups)

  const on = <T>(event: string, handler: (data: T) => void): void => {
    auditAgentService.on(event, handler)
    cleanups.push(() => auditAgentService.off(event, handler))
  }

  // ── progress ──
  on<AuditProgressPayload>('progress', (data: AuditProgressPayload) => {
    // Update result row status when it transitions to 'running' or 'cancelled'
    if (data.status === 'running' || data.status === 'cancelled') {
      const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
      if (resultRow) {
        auditRepository.updateResult(resultRow.id, {
          status: data.status,
          ...(data.status === 'running' ? { startedAt: new Date().toISOString() } : {})
        })
      }
    }

    mainWindow.webContents.send(IPC_CHANNELS.AUDIT_PROGRESS, {
      workspaceId,
      ...data
    })
  })

  // ── result ──
  on<AuditResultPayload>('result', (data: AuditResultPayload) => {
    // Persist to DB (including coverage data)
    const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
    if (resultRow) {
      auditRepository.updateResult(resultRow.id, {
        status: data.status,
        score: data.score,
        findings: data.findings,
        summary: data.summary,
        skillsUsed: data.skillsUsed,
        completedAt: new Date().toISOString(),
        coverageStats: data.coverageStats,
        coverageSufficient: data.coverageSufficient
      })
    }

    // Forward to renderer
    const updatedResult = resultRow ? auditRepository.findResultById(resultRow.id) : null
    if (updatedResult) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_RESULT, updatedResult)
    }
  })

  // ── intermediate findings — live accumulation during multi-round ──
  on<AuditIntermediateFindingsPayload>('intermediate_findings', (data: AuditIntermediateFindingsPayload) => {
    // Persist partial findings to DB for crash resilience
    const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
    if (resultRow) {
      auditRepository.updateResult(resultRow.id, {
        findings: data.findings,
        summary: `Round ${data.roundNumber}: ${data.findings.length} finding(s), ${data.coverageStats.fileCount} files inspected`,
        coverageStats: data.coverageStats
      })
    }

    // Forward to renderer for live display
    mainWindow.webContents.send(IPC_CHANNELS.AUDIT_INTERMEDIATE, {
      workspaceId,
      trackId: data.trackId,
      findings: data.findings,
      coverageStats: data.coverageStats,
      roundNumber: data.roundNumber,
      totalRounds: data.totalRounds,
      totalFiles: data.totalFiles,
      batchSize: data.batchSize
    })
  })

  // ── complete ──
  on<AuditCompletePayload>('complete', (data: AuditCompletePayload) => {
    // Determine final run status
    const results = auditRepository.findResultsByRunId(runId)
    const hasFailed = results.some((r) => r.status === 'failed')
    const hasCancelled = results.some((r) => r.status === 'cancelled')

    let finalStatus: 'completed' | 'partial' | 'cancelled' = 'completed'
    if (hasCancelled && !results.some((r) => r.status === 'completed')) {
      finalStatus = 'cancelled'
    } else if (hasFailed || hasCancelled) {
      finalStatus = 'partial'
    }

    const updatedRun = auditRepository.updateRun(runId, {
      status: finalStatus,
      overallScore: data.overallScore
    })

    if (updatedRun) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_COMPLETE, updatedRun)
    }

    auditLog.info(
      `[audit:complete] runId=${runId} status=${finalStatus} overallScore=${data.overallScore}`
    )
  })

  // ── stream — rich chunk forwarding for chat-like audit view ──
  on<{ trackId: AuditTrackId; chunk: StreamChunk }>('stream', (data: { trackId: AuditTrackId; chunk: StreamChunk }) => {
    const { trackId, chunk } = data

    if (chunk.type === 'text' && chunk.content) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_STREAM_CHUNK, {
        workspaceId,
        trackId,
        type: 'text',
        content: chunk.content
      })
    } else if (chunk.type === 'tool_use') {
      // Skip control tools
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      let inputSummary: string | undefined
      if (chunk.toolInput) {
        // CLI streams already provide summarized input (from stream-normalizer)
        inputSummary = chunk.toolInput.slice(0, 120)
      }

      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_STREAM_CHUNK, {
        workspaceId,
        trackId,
        type: 'tool_activity',
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          input: inputSummary,
          startedAt: Date.now()
        }
      })
    } else if (chunk.type === 'tool_result') {
      // Skip control tools
      if (chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)) return

      const isToolError =
        typeof chunk.content === 'string' && chunk.content.includes('<tool_use_error>')

      // Skip reporting prompt-format artifacts that the model sometimes emits as tool calls.
      // audit-finding / audit-score are fenced-block language tags, not real tools.
      const AUDIT_FORMAT_TAGS = new Set(['audit-finding', 'audit-score'])

      // Auto-capture tool errors to the bug tracker (skip known format tags)
      if (isToolError && chunk.content && !AUDIT_FORMAT_TAGS.has(chunk.toolName ?? '')) {
        reportToolError(chunk.toolName ?? 'Unknown', chunk.content, {
          agentType: 'audit',
          workspaceId
        })
      }

      const resultSummaryObj = extractResultSummary(chunk.toolName ?? '', chunk.content)
      let resultSummary = resultSummaryObj?.result
      const resultDetail = resultSummaryObj?.resultDetail

      // Try to get input summary from result content for tool_result
      let inputSummary: string | undefined
      if (chunk.content) {
        try {
          const parsed = JSON.parse(chunk.content) as Record<string, unknown>
          inputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, workspacePath)
        } catch {
          // Non-JSON content — skip input summary
        }
      }

      // For Read, compose file path into result so it's always visible
      if (chunk.toolName === 'Read' && inputSummary && resultSummary) {
        resultSummary = `${resultSummary} — ${inputSummary}`
      }

      const toolActivity: Record<string, unknown> = {
        id: chunk.toolId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: isToolError ? 'error' : 'completed',
        completedAt: Date.now()
      }
      if (inputSummary) toolActivity.input = inputSummary
      if (resultSummary) toolActivity.result = resultSummary
      if (resultDetail) toolActivity.resultDetail = resultDetail

      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_STREAM_CHUNK, {
        workspaceId,
        trackId,
        type: 'tool_activity',
        toolActivity
      })
    } else if (chunk.type === 'tool_progress') {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_STREAM_CHUNK, {
        workspaceId,
        trackId,
        type: 'tool_activity',
        toolActivity: {
          id: chunk.toolId ?? `tool-${Date.now()}`,
          toolName: chunk.toolName ?? 'Unknown',
          status: 'running' as const,
          elapsedSeconds: chunk.elapsedSeconds
        }
      })
    }
  })
}

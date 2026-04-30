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
import { extractResultSummary } from './chat-shared'
import { auditRepository, conversationRepository, messageRepository } from '../db/repositories'
import { workspaceRepository } from '../db/repositories'
import { detectTechStack } from '../services/tech-stack-detector.service'
import {
  auditAgentService,
  type AuditProgressPayload,
  type AuditResultPayload,
  type AuditCompletePayload
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
      args: { workspaceId: string; mode: AuditMode; tracks: AuditTrackId[] }
    ): Promise<AuditRun> => {
      validateSender(event)

      const { workspaceId, mode, tracks } = args

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

      // Create new run in DB (deletes previous for this workspace)
      const run = auditRepository.createRun(workspaceId, mode, tracks, detectedTechs)
      const results = auditRepository.createResults(run.id, tracks)
      run.results = results

      auditLog.info(
        `[audit:start] workspaceId=${workspaceId} mode=${mode} tracks=${tracks.join(',')} runId=${run.id}`
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
          auditRunId: run.id
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
      return auditRepository.getLatestForWorkspace(args.workspaceId)
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
          if (completed.length > 0) {
            let weightedSum = 0
            let totalWeight = 0
            for (const r of completed) {
              const w = AUDIT_TRACKS[r.trackId]?.weight ?? 1.0
              weightedSum += (r.score ?? 0) * w
              totalWeight += w
            }
            const newOverall = Math.round(weightedSum / totalWeight)
            const updatedRun = auditRepository.updateRun(latestRun.id, { overallScore: newOverall })
            if (updatedRun) {
              mainWindow.webContents.send(IPC_CHANNELS.AUDIT_COMPLETE, updatedRun)
            }
          }
        })
        .catch((err) => {
          auditLog.error('[audit:rerunTrack] failed:', err)
        })
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
      const wsRow = workspaceRepository.findById(workspaceId)
      const wsSettings = JSON.parse(wsRow?.settingsJson ?? '{}')
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
function wireAuditEvents(mainWindow: BrowserWindow, runId: string, workspaceId: string, workspacePath: string): void {
  // Remove any stale listeners from a previous run
  auditAgentService.removeAllListeners('progress')
  auditAgentService.removeAllListeners('result')
  auditAgentService.removeAllListeners('complete')
  auditAgentService.removeAllListeners('stream')

  // ── progress ──
  auditAgentService.on('progress', (data: AuditProgressPayload) => {
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
  auditAgentService.on('result', (data: AuditResultPayload) => {
    // Persist to DB
    const resultRow = auditRepository.findResultByTrack(runId, data.trackId)
    if (resultRow) {
      auditRepository.updateResult(resultRow.id, {
        status: data.status,
        score: data.score,
        findings: data.findings,
        summary: data.summary,
        skillsUsed: data.skillsUsed,
        completedAt: new Date().toISOString()
      })
    }

    // Forward to renderer
    const updatedResult = resultRow ? auditRepository.findResultById(resultRow.id) : null
    if (updatedResult) {
      mainWindow.webContents.send(IPC_CHANNELS.AUDIT_RESULT, updatedResult)
    }
  })

  // ── complete ──
  auditAgentService.on('complete', (data: AuditCompletePayload) => {
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
  auditAgentService.on('stream', (data: { trackId: AuditTrackId; chunk: StreamChunk }) => {
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
        try {
          const parsed = JSON.parse(chunk.toolInput) as Record<string, unknown>
          inputSummary = summarizeToolInput(chunk.toolName ?? '', parsed, workspacePath)
        } catch {
          inputSummary = chunk.toolInput.slice(0, 120)
        }
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
      let resultSummary = extractResultSummary(chunk.toolName ?? '', chunk.content)

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

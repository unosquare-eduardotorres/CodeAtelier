/**
 * IPC handlers for Workspace Health audits.
 *
 * Bridges the renderer ↔ AuditAgentService, persists results to the DB,
 * and forwards streaming events to the renderer via webContents.send().
 */

import type { BrowserWindow } from 'electron'
import { ipcMain, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC_CHANNELS, AUDIT_TRACKS } from '../../shared/constants'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditFindingHandoff,
  AuditHandoffTarget,
  AuditRun,
  AuditPlanRecord,
  AuditSelectedSkills,
  LLMProvider,
  AgentStatus
} from '../../shared/types'
import {
  buildAuditBlueprintTitle,
  deriveBlueprintPriority,
  formatAuditFindingsBrief
} from '../../shared/audit-blueprint-format'
import type { StreamChunk } from '../services/agent-base.service'
import {
  formatDirectFindings,
  formatConsolidatedPlan,
  buildHandoffTitle
} from '../services/audit-handoff.service'
import { processToolChunk } from './tool-chunk-processor'
import { randomUUID } from 'node:crypto'
import { createTimedCleanupMap } from './listener-cleanup'
import {
  auditRepository,
  auditHandoffRepository,
  auditPlanRepository,
  conversationRepository,
  conversationSpecialistRepository,
  messageRepository,
  handoffRepository,
  specialistRepository
} from '../db/repositories'
import { workspaceRepository } from '../db/repositories'
import { blueprintService } from '../services/blueprint.service'
import { requireObject, requireString, requireStringArray, optionalString } from './validate-args'
import type { HandoffEnvelope } from '../../shared/handoff-types'
import { buildConversationModelSnapshot } from '../services/model-config.service'
import { auditPlanGeneratorService } from '../services/audit-plan-generator.service'
import { detectTechStack } from '../services/tech-stack-detector.service'
import {
  auditAgentService,
  type AuditProgressPayload,
  type AuditResultPayload,
  type AuditCompletePayload,
  type AuditIntermediateFindingsPayload
} from '../services/audit-agent.service'
import { getSessionEventRouter } from '../services/session-event-router'
import { validateSender } from './validate-sender'
import { notificationService } from '../services/notification.service'
import { resolveWorkspaceName } from './resolve-workspace-name'
import log from 'electron-log'

const auditLog = log.scope('audit-ipc')

/**
 * Ceiling for one Audit → Blueprint handoff. Past this the requirement document
 * stops fitting a single Specify pass and the batch should be split.
 */
const MAX_BLUEPRINT_FINDINGS = 50

// ── Public entry point ──────────────────────────────────────────────────────

export function registerAuditIpc(mainWindow: BrowserWindow): void {
  registerAuditLifecycleHandlers(mainWindow)
  registerAuditQueryHandlers(mainWindow)
  registerAuditExportHandlers(mainWindow)
  registerAuditHandoffHandlers(mainWindow)
}

// ── Lifecycle Handlers ──────────────────────────────────────────────────────

function registerAuditLifecycleHandlers(_mainWindow: BrowserWindow): void {
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
        selectedSkills?: AuditSelectedSkills
      }
    ): Promise<AuditRun> => {
      validateSender(event)

      const { workspaceId, mode, tracks, llmProvider: explicitProvider, selectedSkills } = args

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
      const run = auditRepository.createRun(
        workspaceId,
        mode,
        tracks,
        detectedTechs,
        selectedSkills ?? {}
      )
      const results = auditRepository.createResults(run.id, tracks)
      run.results = results

      auditLog.info(
        `[audit:start] workspaceId=${workspaceId} mode=${mode} tracks=${tracks.join(',')} provider=${llmProvider} runId=${run.id}`
      )

      // Wire event forwarding: auditAgentService → renderer + DB
      wireAuditEvents(run.id, workspaceId, workspace.repoPath)

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
      wireAuditEvents(latestRun.id, workspaceId, workspace.repoPath)

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
          // Exclude insufficient-coverage tracks — mirrors calculateOverallScore.
          const completed = results.filter(
            (r) => r.status === 'completed' && r.score !== null && r.coverageSufficient !== false
          )
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
            try {
              const router = getSessionEventRouter()
              router.sendWorkspaceEvent(
                IPC_CHANNELS.AUDIT_COMPLETE,
                workspaceId,
                updatedRun as unknown as Record<string, unknown>
              )
            } catch {
              /* router may not be initialized */
            }
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
      wireAuditEvents(run.id, args.workspaceId, workspace.repoPath)

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
}

// ── Query Handlers ──────────────────────────────────────────────────────────

function registerAuditQueryHandlers(mainWindow: BrowserWindow): void {
  void mainWindow // used by lifecycle/export groups — kept for signature consistency

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

  // ── audit:getHistory — get recent audit runs ──────────────────────

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }): AuditRun[] => {
      validateSender(event)
      return auditRepository.getHistoryForWorkspace(args.workspaceId, args.limit ?? 10)
    }
  )

  // ── audit:deleteRun — delete a single past run ──────────────────────

  ipcMain.handle(IPC_CHANNELS.AUDIT_DELETE_RUN, (event, rawArgs: unknown): { deleted: boolean } => {
    validateSender(event)
    const ch = IPC_CHANNELS.AUDIT_DELETE_RUN
    const runId = requireString(requireObject(rawArgs, ch), 'runId', ch)
    const deleted = auditRepository.deleteRun(runId)
    auditLog.info(`[audit:deleteRun] runId=${runId} deleted=${deleted}`)
    return { deleted }
  })

  // ── audit:generatePlan — synthesize a remediation plan from findings ──

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_GENERATE_PLAN,
    async (
      event,
      args: { workspaceId: string; runId: string; findings: AuditFinding[] }
    ): Promise<AuditPlanRecord> => {
      validateSender(event)
      auditLog.info(`[audit:generatePlan] runId=${args.runId} findings=${args.findings.length}`)
      return auditPlanGeneratorService.generate({
        workspaceId: args.workspaceId,
        runId: args.runId,
        findings: args.findings
      })
    }
  )

  // ── audit:getPlans — list plans persisted for a run ──

  ipcMain.handle(IPC_CHANNELS.AUDIT_GET_PLANS, (event, rawArgs: unknown): AuditPlanRecord[] => {
    validateSender(event)
    const ch = IPC_CHANNELS.AUDIT_GET_PLANS
    const runId = requireString(requireObject(rawArgs, ch), 'runId', ch)
    return auditPlanRepository.getPlansForRun(runId)
  })
}

// ── Export Helpers ──────────────────────────────────────────────────────────

async function saveMarkdownFile(
  mainWindow: BrowserWindow,
  markdown: string,
  defaultPath: string,
  title: string,
  logLabel: string
): Promise<void> {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (canceled || !filePath) return
  await writeFile(filePath, markdown, 'utf-8')
  auditLog.info(`[${logLabel}] Exported to ${filePath}`)
}

// ── Export Handlers ─────────────────────────────────────────────────────────

function registerAuditExportHandlers(mainWindow: BrowserWindow): void {
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

      // Create conversation in plan mode with frozen model snapshot
      const title = `🔍 Audit: Fix ${findings.length} finding${findings.length > 1 ? 's' : ''}`
      const snapshot = buildConversationModelSnapshot(workspaceId, llmProvider)
      const conv = conversationRepository.create(
        workspaceId,
        title,
        'plan',
        undefined,
        llmProvider,
        undefined,
        undefined,
        undefined,
        snapshot
      )

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

  // ── audit:handoffToChat — create conversation(s) from audit findings ──
  // (Moved to registerAuditHandoffHandlers below)

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

      await saveMarkdownFile(
        mainWindow,
        markdown,
        `health-report-${new Date().toISOString().slice(0, 10)}.md`,
        'Export Audit Report',
        'audit:export'
      )
    }
  )

  // ── audit:exportPlanMarkdown — export the remediation plan as Markdown ───

  ipcMain.handle(
    IPC_CHANNELS.AUDIT_EXPORT_PLAN_MARKDOWN,
    async (event, args: { workspaceId: string }): Promise<void> => {
      validateSender(event)

      const run = auditRepository.getLatestForWorkspace(args.workspaceId)
      if (!run) throw new Error('No audit run found for this workspace')

      const plans = auditPlanRepository.getPlansForRun(run.id)
      if (plans.length === 0) throw new Error('No remediation plan found for this audit run')

      const planRecord = plans[0]
      const plan = planRecord.plan

      // If the plan has a requirementDocument, export that directly
      if (plan.requirementDocument?.trim()) {
        await saveMarkdownFile(
          mainWindow,
          plan.requirementDocument,
          `remediation-plan-${new Date().toISOString().slice(0, 10)}.md`,
          'Export Remediation Plan',
          'audit:exportPlan'
        )
        return
      }

      // Fallback: build structured markdown from plan items
      const workspace = workspaceRepository.findById(args.workspaceId)
      const workspaceName = workspace?.name ?? 'Unknown Workspace'
      const date = new Date(planRecord.createdAt).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })

      const lines: string[] = [
        `# ${plan.title}`,
        '',
        `**Workspace:** ${workspaceName} | **Date:** ${date} | **Items:** ${plan.items.length} | **Findings addressed:** ${plan.sourceFindingIds.length}`,
        '',
        plan.summary,
        ''
      ]

      for (let i = 0; i < plan.items.length; i++) {
        const item = plan.items[i]
        const severity = item.severity ? ` \`${item.severity.toUpperCase()}\`` : ''
        lines.push(`## ${i + 1}. ${item.title}${severity}`)
        lines.push('')
        lines.push(`**Scope:** ${item.scope}`)
        lines.push('')
        lines.push(item.description)
        lines.push('')
        if (item.recommendation) {
          lines.push(`> 💡 ${item.recommendation}`)
          lines.push('')
        }
        if (item.files.length > 0) {
          lines.push(`**Files:** ${item.files.map((f) => '`' + f + '`').join(', ')}`)
          lines.push('')
        }
        if (item.dependsOn && item.dependsOn.length > 0) {
          lines.push(`**Depends on:** ${item.dependsOn.join(', ')}`)
          lines.push('')
        }
      }

      if (plan.risks.length > 0) {
        lines.push('## ⚠️ Risks')
        lines.push('')
        for (const risk of plan.risks) {
          lines.push(`- ${risk}`)
        }
        lines.push('')
      }

      const markdown = lines.join('\n')

      await saveMarkdownFile(
        mainWindow,
        markdown,
        `remediation-plan-${new Date().toISOString().slice(0, 10)}.md`,
        'Export Remediation Plan',
        'audit:exportPlan'
      )
    }
  )
}

// ── Handoff Handlers (Audit → Chat) ─────────────────────────────────────────

function registerAuditHandoffHandlers(_mainWindow: BrowserWindow): void {
  ipcMain.handle(
    IPC_CHANNELS.AUDIT_HANDOFF_TO_CHAT,
    (
      event,
      args: {
        workspaceId: string
        auditRunId: string
        trackIds?: AuditTrackId[]
        mode: 'consolidated' | 'split'
      }
    ): { conversationIds: string[]; count: number } => {
      validateSender(event)

      const { workspaceId, auditRunId, trackIds, mode } = args

      // Load the audit run with results
      const run = auditRepository.findRunById(auditRunId)
      if (!run || run.workspaceId !== workspaceId) {
        throw new Error(`Audit run ${auditRunId} not found for workspace ${workspaceId}`)
      }

      // Filter to requested tracks (or all completed with actionable findings)
      const completedResults = run.results.filter(
        (r) =>
          r.status === 'completed' &&
          r.findings.some((f) => f.severity !== 'info') &&
          (!trackIds || trackIds.includes(r.trackId))
      )

      if (completedResults.length === 0) {
        throw new Error('No completed results with actionable findings')
      }

      const wsSettings = workspaceRepository.getSettings(workspaceId)
      const llmProvider: LLMProvider = wsSettings.llmProvider ?? 'claude'
      const conversationIds: string[] = []

      if (mode === 'split') {
        // Create one conversation per track.
        // NOTE: Split-flow conversations are created with the findings as a user message
        // but do NOT auto-trigger an LLM response. The user clicks into a conversation
        // and sends a follow-up message (e.g. "Fix these") to engage the LLM.
        for (const result of completedResults) {
          const actionableCount = result.findings.filter((f) => f.severity !== 'info').length
          const title = buildHandoffTitle('split', result.trackId, actionableCount)
          const contextMessage = formatDirectFindings(result)
          const snapshot = buildConversationModelSnapshot(workspaceId, llmProvider)

          const conv = conversationRepository.create(
            workspaceId,
            title,
            'plan',
            undefined,
            llmProvider,
            undefined,
            undefined,
            undefined,
            snapshot,
            auditRunId
          )

          // Initialize specialist defaults (mirrors conversation-crud.ipc.ts)
          conversationSpecialistRepository.initFromWorkspaceDefaults(conv.id)
          try {
            const projectSpecialist = specialistRepository.findByAgentId(
              `workspace-specialist-${workspaceId}`
            )
            if (projectSpecialist) {
              conversationSpecialistRepository.upsert(conv.id, projectSpecialist.id, {
                isActive: true
              })
            }
          } catch (e) {
            auditLog.warn('Project Specialist auto-attach failed:', e)
          }

          messageRepository.create(conv.id, 'user', contextMessage)
          conversationIds.push(conv.id)

          // Mark the findings this conversation consumed, so the findings list
          // can show they have already been routed somewhere.
          auditHandoffRepository.record({
            auditRunId,
            findingIds: result.findings.filter((f) => f.severity !== 'info').map((f) => f.id),
            target: 'chat',
            refId: conv.id,
            refTitle: title
          })

          // Record handoff event
          const envelope: HandoffEnvelope = {
            id: randomUUID(),
            version: 1,
            source: 'audit',
            target: 'chat',
            workspaceId,
            intent: `Fix ${actionableCount} ${result.trackId} audit finding(s)`,
            originalGoal: title,
            contextSummary: `Audit findings from ${result.trackId} track (score: ${result.score ?? 'N/A'}/100)`,
            completedWork: [],
            remainingWork: result.findings
              .filter((f) => f.severity !== 'info')
              .map((f) => ({
                title: f.title,
                description: f.description,
                priority:
                  f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'high' : 'medium'
              })),
            decisions: [],
            constraints: [],
            risks: [],
            artifacts: [
              { type: 'finding', path: auditRunId, description: `Audit run ${auditRunId}` }
            ],
            suggestedTools: [],
            suggestedSkills: [],
            filesToReadFirst: result.findings
              .filter((f) => f.filePath)
              .map((f) => f.filePath!)
              .slice(0, 10),
            commandsToRunFirst: [],
            sourceSessionId: auditRunId,
            confidence: 0.8,
            priority: 'medium',
            createdAt: new Date().toISOString(),
            createdBy: 'user'
          }
          handoffRepository.create(envelope)
        }

        auditLog.info(
          `[audit:handoff] Split: created ${conversationIds.length} conversations from run ${auditRunId}`
        )
      } else {
        // Consolidated: single conversation with all findings
        const totalIssues = completedResults.flatMap((r) =>
          r.findings.filter((f) => f.severity !== 'info')
        ).length
        const title = buildHandoffTitle('consolidated', undefined, totalIssues)
        const contextMessage = formatConsolidatedPlan(run)
        const snapshot = buildConversationModelSnapshot(workspaceId, llmProvider)

        const conv = conversationRepository.create(
          workspaceId,
          title,
          'plan',
          undefined,
          llmProvider,
          undefined,
          undefined,
          undefined,
          snapshot,
          auditRunId
        )

        // Initialize specialist defaults (mirrors conversation-crud.ipc.ts)
        conversationSpecialistRepository.initFromWorkspaceDefaults(conv.id)
        try {
          const projectSpecialist = specialistRepository.findByAgentId(
            `workspace-specialist-${workspaceId}`
          )
          if (projectSpecialist) {
            conversationSpecialistRepository.upsert(conv.id, projectSpecialist.id, {
              isActive: true
            })
          }
        } catch (e) {
          auditLog.warn('Project Specialist auto-attach failed:', e)
        }

        messageRepository.create(conv.id, 'user', contextMessage)
        conversationIds.push(conv.id)

        auditHandoffRepository.record({
          auditRunId,
          findingIds: completedResults.flatMap((r) =>
            r.findings.filter((f) => f.severity !== 'info').map((f) => f.id)
          ),
          target: 'chat',
          refId: conv.id,
          refTitle: title
        })

        // Record handoff event
        const envelope: HandoffEnvelope = {
          id: randomUUID(),
          version: 1,
          source: 'audit',
          target: 'chat',
          workspaceId,
          intent: `Fix ${totalIssues} audit finding(s) across ${completedResults.length} auditor(s)`,
          originalGoal: title,
          contextSummary: `Consolidated audit health report (overall score: ${run.overallScore ?? 'N/A'}/100)`,
          completedWork: [],
          remainingWork: completedResults.flatMap((r) =>
            r.findings
              .filter((f) => f.severity !== 'info')
              .map((f) => ({
                title: f.title,
                description: f.description,
                priority:
                  f.severity === 'critical'
                    ? 'critical'
                    : f.severity === 'high'
                      ? 'high'
                      : ('medium' as const)
              }))
          ),
          decisions: [],
          constraints: [],
          risks: [],
          artifacts: [
            { type: 'finding', path: auditRunId, description: `Audit run ${auditRunId}` }
          ],
          suggestedTools: [],
          suggestedSkills: [],
          filesToReadFirst: completedResults
            .flatMap((r) => r.findings.filter((f) => f.filePath).map((f) => f.filePath!))
            .slice(0, 10),
          commandsToRunFirst: [],
          sourceSessionId: auditRunId,
          confidence: 0.8,
          priority: 'medium',
          createdAt: new Date().toISOString(),
          createdBy: 'user'
        }
        handoffRepository.create(envelope)

        auditLog.info(
          `[audit:handoff] Consolidated: created conversation ${conv.id} from run ${auditRunId}`
        )
      }

      return { conversationIds, count: conversationIds.length }
    }
  )

  // ── audit:handoffToBlueprint — turn selected findings into one blueprint ──
  //
  // The blueprint pipeline (specify → clarify → plan → tasks → review → build →
  // verify) is the right target for a large batch: chat has no task breakdown
  // or verification gate, which is what a ten-finding remediation needs.
  ipcMain.handle(
    IPC_CHANNELS.AUDIT_HANDOFF_TO_BLUEPRINT,
    (event, rawArgs: unknown): { blueprintId: string; title: string; findingCount: number } => {
      validateSender(event)
      const ch = IPC_CHANNELS.AUDIT_HANDOFF_TO_BLUEPRINT
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const auditRunId = requireString(args, 'auditRunId', ch)
      const findingIds = requireStringArray(args, 'findingIds', ch)

      const run = auditRepository.findRunById(auditRunId)
      if (!run || run.workspaceId !== workspaceId) {
        throw new Error(`${ch}: audit run ${auditRunId} not found for workspace ${workspaceId}`)
      }

      // Resolve the findings from the persisted run rather than trusting a
      // renderer-supplied payload, and so a stale selection referencing a
      // re-run track quietly drops instead of seeding an empty blueprint.
      const wanted = new Set(findingIds)
      const findings = run.results.flatMap((r) => r.findings.filter((f) => wanted.has(f.id)))
      if (findings.length === 0) {
        throw new Error(`${ch}: none of the selected findings belong to run ${auditRunId}`)
      }
      if (findings.length > MAX_BLUEPRINT_FINDINGS) {
        throw new Error(
          `${ch}: too many findings (${findings.length}); select at most ${MAX_BLUEPRINT_FINDINGS}.`
        )
      }

      const title = buildAuditBlueprintTitle(findings)
      const blueprint = blueprintService.create({
        workspaceId,
        title,
        description: formatAuditFindingsBrief(findings, { auditRunId }),
        priority: deriveBlueprintPriority(findings),
        settingsJson: {
          sourceAuditRunId: auditRunId,
          sourceAuditFindingIds: findings.map((f) => f.id)
        }
      })

      auditHandoffRepository.record({
        auditRunId,
        findingIds: findings.map((f) => f.id),
        target: 'blueprint',
        refId: blueprint.id,
        refTitle: title
      })

      const envelope: HandoffEnvelope = {
        id: randomUUID(),
        version: 1,
        source: 'audit',
        target: 'blueprint',
        workspaceId,
        intent: `Fix ${findings.length} audit finding(s) through the blueprint pipeline`,
        originalGoal: title,
        contextSummary: `Audit findings selected from run ${auditRunId}`,
        completedWork: [],
        remainingWork: findings.map((f) => ({
          title: f.title,
          description: f.description,
          priority:
            f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'high' : 'medium'
        })),
        decisions: [],
        constraints: [],
        risks: [],
        artifacts: [{ type: 'finding', path: auditRunId, description: `Audit run ${auditRunId}` }],
        suggestedTools: [],
        suggestedSkills: [],
        filesToReadFirst: findings
          .filter((f) => f.filePath)
          .map((f) => f.filePath!)
          .slice(0, 10),
        commandsToRunFirst: [],
        sourceSessionId: auditRunId,
        confidence: 0.8,
        priority: 'medium',
        createdAt: new Date().toISOString(),
        createdBy: 'user'
      }
      handoffRepository.create(envelope)

      auditLog.info(
        `[audit:handoff] Created blueprint ${blueprint.id} from ${findings.length} finding(s) of run ${auditRunId}`
      )

      return { blueprintId: blueprint.id, title, findingCount: findings.length }
    }
  )

  // ── audit:recordFindingHandoff — mark findings as already routed ──
  //
  // The chat handoffs build their conversation in the renderer (pendingFixContext),
  // so they cannot record the marker where the conversation is created; they call
  // this instead.
  ipcMain.handle(
    IPC_CHANNELS.AUDIT_RECORD_FINDING_HANDOFF,
    (event, rawArgs: unknown): AuditFindingHandoff[] => {
      validateSender(event)
      const ch = IPC_CHANNELS.AUDIT_RECORD_FINDING_HANDOFF
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const auditRunId = requireString(args, 'auditRunId', ch)
      const findingIds = requireStringArray(args, 'findingIds', ch)
      const target = requireString(args, 'target', ch)
      const refId = optionalString(args, 'refId', ch)
      const refTitle = optionalString(args, 'refTitle', ch)

      if (target !== 'chat' && target !== 'blueprint') {
        throw new Error(`${ch}: target must be 'chat' or 'blueprint', got '${target}'`)
      }

      const run = auditRepository.findRunById(auditRunId)
      if (!run || run.workspaceId !== workspaceId) {
        throw new Error(`${ch}: audit run ${auditRunId} not found for workspace ${workspaceId}`)
      }

      // Only mark ids that actually exist in the run — a stale selection must not
      // leave orphan markers that no finding row can ever clear.
      const known = new Set(run.results.flatMap((r) => r.findings.map((f) => f.id)))
      const valid = findingIds.filter((id) => known.has(id))
      if (valid.length === 0) return []

      return auditHandoffRepository.record({
        auditRunId,
        findingIds: valid,
        target: target as AuditHandoffTarget,
        refId,
        refTitle
      })
    }
  )

  // ── audit:getFindingHandoffs — markers for one run ──
  ipcMain.handle(
    IPC_CHANNELS.AUDIT_GET_FINDING_HANDOFFS,
    (event, rawArgs: unknown): AuditFindingHandoff[] => {
      validateSender(event)
      const ch = IPC_CHANNELS.AUDIT_GET_FINDING_HANDOFFS
      const auditRunId = requireString(requireObject(rawArgs, ch), 'auditRunId', ch)
      return auditHandoffRepository.findByRun(auditRunId)
    }
  )
}

// ── Event Forwarding ────────────────────────────────────────────────────────

/**
 * Wire one-time event listeners for the current audit run.
 * Forwards progress/result/complete to the renderer and persists to DB.
 */
/** Per-workspace listener cleanup functions. */
const auditCleanup = createTimedCleanupMap('audit')

function wireAuditEvents(runId: string, workspaceId: string, workspacePath: string): void {
  const cleanups = auditCleanup.prepareCleanups(workspaceId)
  // Lazy router resolution

  // ── progress ──
  auditCleanup.addListener<AuditProgressPayload>(
    cleanups,
    auditAgentService,
    'progress',
    (data) => {
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

      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.AUDIT_PROGRESS,
        workspaceId,
        data as unknown as Record<string, unknown>
      )
    }
  )

  // ── result ──
  auditCleanup.addListener<AuditResultPayload>(cleanups, auditAgentService, 'result', (data) => {
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
      getSessionEventRouter().sendWorkspaceEvent(
        IPC_CHANNELS.AUDIT_RESULT,
        workspaceId,
        updatedResult as unknown as Record<string, unknown>
      )
    }
  })

  // ── intermediate findings — live accumulation during multi-round ──
  auditCleanup.addListener<AuditIntermediateFindingsPayload>(
    cleanups,
    auditAgentService,
    'intermediate_findings',
    (data) => {
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
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AUDIT_INTERMEDIATE, workspaceId, {
        trackId: data.trackId,
        findings: data.findings,
        coverageStats: data.coverageStats,
        roundNumber: data.roundNumber,
        totalRounds: data.totalRounds,
        totalFiles: data.totalFiles,
        batchSize: data.batchSize
      })
    }
  )

  // ── complete ──
  auditCleanup.addListener<AuditCompletePayload>(
    cleanups,
    auditAgentService,
    'complete',
    (data) => {
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
        getSessionEventRouter().sendWorkspaceEvent(
          IPC_CHANNELS.AUDIT_COMPLETE,
          workspaceId,
          updatedRun as unknown as Record<string, unknown>
        )
      }

      // Skip user-initiated cancellations — no notification needed
      if (finalStatus !== 'cancelled') {
        notificationService.dispatch({
          workspaceId,
          workspaceName: resolveWorkspaceName(workspaceId),
          service: 'audit',
          status: 'completed',
          summary:
            finalStatus === 'partial'
              ? `Audit finished (partial) — overall score: ${data.overallScore ?? 'N/A'}`
              : `Audit completed — overall score: ${data.overallScore ?? 'N/A'}`,
          targetPage: 'audit'
        })
      }

      auditLog.info(
        `[audit:complete] runId=${runId} status=${finalStatus} overallScore=${data.overallScore}`
      )

      auditCleanup.runCleanup(workspaceId)
    }
  )

  // ── stream — rich chunk forwarding for chat-like audit view ──
  auditCleanup.addListener<{ trackId: AuditTrackId; chunk: StreamChunk }>(
    cleanups,
    auditAgentService,
    'stream',
    (data) => {
      processAuditStreamChunk(
        getSessionEventRouter(),
        workspaceId,
        workspacePath,
        data.trackId,
        data.chunk
      )
    }
  )

  // ── status — forward live token/context counters to the renderer ──
  auditCleanup.addListener<{ workspaceId?: string; status: AgentStatus }>(
    cleanups,
    auditAgentService,
    'status',
    (data) => {
      if (data.workspaceId && data.workspaceId !== workspaceId) return
      getSessionEventRouter().sendWorkspaceEvent(IPC_CHANNELS.AGENT_STATUS_UPDATE, workspaceId, {
        ...data.status
      })
    }
  )

  // Safety net: auto-clean listeners after 90 min (multi-track sequential execution)
  auditCleanup.scheduleAutoCleanup(workspaceId, cleanups, 90 * 60_000)
}

// ── Stream chunk processing ─────────────────────────────────────────────────

/**
 * Process a single stream chunk from the audit agent and forward it to the renderer.
 * Handles text, tool_use, tool_result, and tool_progress chunk types.
 */
import type { SessionEventRouter } from '../services/session-event-router'

function processAuditStreamChunk(
  router: SessionEventRouter,
  workspaceId: string,
  workspacePath: string,
  trackId: AuditTrackId,
  chunk: StreamChunk
): void {
  if (chunk.type === 'text' && chunk.content) {
    router.sendWorkspaceEvent(IPC_CHANNELS.AUDIT_STREAM_CHUNK, workspaceId, {
      trackId,
      type: 'text',
      content: chunk.content
    })
    return
  }

  if (chunk.type === 'tool_use' || chunk.type === 'tool_result' || chunk.type === 'tool_progress') {
    const result = processToolChunk(chunk, {
      workspacePath,
      agentType: 'audit',
      workspaceId,
      formatTagsToSkip: ['audit-finding', 'audit-score']
    })
    if (result) {
      router.sendWorkspaceEvent(IPC_CHANNELS.AUDIT_STREAM_CHUNK, workspaceId, {
        trackId,
        ...result
      })
    }
  }
}

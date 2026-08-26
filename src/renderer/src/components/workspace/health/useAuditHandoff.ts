/**
 * useAuditHandoff — Orchestrates the Audit → Chat / Blueprint handoff flows.
 *
 * Provides handlers for:
 *   - "Send All to Chat" (consolidated mode)
 *   - "Split by Track" (opens track picker, then creates N conversations)
 *   - "Fix in Chat" from the selection tray (uses pendingFixContext pattern)
 *   - "Fix in Blueprint" from the selection tray (creates a blueprint)
 *
 * Every handoff records a marker against the findings it consumed, so the
 * findings list can show which ones have already been worked on.
 */

import { useState, useCallback } from 'react'
import { useAuditStore, useChatStore } from '@renderer/store'
import { unwrapIpcError } from '@renderer/store/code-changes-errors'
import { AUDIT_TRACKS } from '../../../../../shared/constants'
import type { AuditRun, AuditTrackId } from '../../../../../shared/types'
import {
  formatDirectFindings,
  formatConsolidatedPlan,
  buildHandoffTitle
} from '../../../utils/audit-handoff-formatter'

interface UseAuditHandoffResult {
  showTrackPicker: boolean
  /** True while a blueprint is being created from the selection. */
  isHandingOff: boolean
  /** Why the last blueprint handoff failed, for display next to the action. */
  handoffError: string | null
  trackPickerOptions: Array<{
    id: AuditTrackId
    name: string
    issueCount: number
    score: number | null
  }>
  handleSendAllToChat: () => void
  handleSplitByTrack: () => void
  handleSplitConfirm: (trackIds: AuditTrackId[]) => Promise<void>
  handleCloseTrackPicker: () => void
  handleFixInChat: () => void
  handleFixInBlueprint: () => Promise<void>
}

export function useAuditHandoff(
  workspaceId: string | undefined,
  currentRun: AuditRun | null,
  onFixInNewChat: () => void,
  onNavigateToChat?: () => void,
  onNavigateToBlueprints?: () => void
): UseAuditHandoffResult {
  const [showTrackPicker, setShowTrackPicker] = useState(false)
  const [isHandingOff, setIsHandingOff] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)

  const {
    selectedFindings,
    clearSelectedFindings,
    setPendingFixContext,
    recordFindingHandoff,
    loadFindingHandoffs,
    handoffToBlueprint
  } = useAuditStore()

  // Derive track options for the picker
  const trackPickerOptions = (currentRun?.results ?? [])
    .filter((r) => r.status === 'completed')
    .map((r) => ({
      id: r.trackId,
      name: AUDIT_TRACKS[r.trackId]?.name ?? r.trackId,
      issueCount: r.findings.filter((f) => f.severity !== 'info').length,
      score: r.score
    }))

  // "Send All to Chat" — consolidated single conversation
  const handleSendAllToChat = useCallback(() => {
    if (!currentRun || !workspaceId) return

    const completedResults = currentRun.results.filter(
      (r) => r.status === 'completed' && r.findings.some((f) => f.severity !== 'info')
    )

    if (completedResults.length === 0) return

    const handedOffIds = completedResults.flatMap((r) =>
      r.findings.filter((f) => f.severity !== 'info').map((f) => f.id)
    )

    if (completedResults.length === 1) {
      // Single track → direct findings
      const result = completedResults[0]
      const issueCount = result.findings.filter((f) => f.severity !== 'info').length
      setPendingFixContext({
        title: buildHandoffTitle('split', result.trackId, issueCount),
        description: formatDirectFindings(result),
        autoSend: true,
        sourceAuditRunId: currentRun.id
      })
    } else {
      // Multi-track → consolidated plan
      const totalIssues = completedResults.flatMap((r) =>
        r.findings.filter((f) => f.severity !== 'info')
      ).length
      setPendingFixContext({
        title: buildHandoffTitle('consolidated', undefined, totalIssues),
        description: formatConsolidatedPlan(currentRun),
        autoSend: true,
        sourceAuditRunId: currentRun.id
      })
    }

    // The conversation is created downstream from pendingFixContext, so there is
    // no id to link yet — the marker records that the work was routed, not where.
    void recordFindingHandoff({ workspaceId, findingIds: handedOffIds, target: 'chat' })

    onFixInNewChat()
  }, [currentRun, workspaceId, setPendingFixContext, recordFindingHandoff, onFixInNewChat])

  // "Split by Track" — open the track picker
  const handleSplitByTrack = useCallback(() => {
    setShowTrackPicker(true)
  }, [])

  // Track picker confirm → call IPC to create N conversations
  const handleSplitConfirm = useCallback(
    async (trackIds: AuditTrackId[]) => {
      if (!workspaceId || !currentRun) return
      setShowTrackPicker(false)

      try {
        await window.api.auditHandoffToChat({
          workspaceId,
          auditRunId: currentRun.id,
          trackIds,
          mode: 'split'
        })
        // Force sidebar to reload with newly created conversations
        await useChatStore.getState().loadConversations(workspaceId)
        // The main process recorded the markers against the conversations it
        // created, so pull them rather than guessing at ids here.
        await loadFindingHandoffs(currentRun.id)
        onNavigateToChat?.()
      } catch (err) {
        console.error('[audit-handoff] Split handoff failed:', err)
      }
    },
    [workspaceId, currentRun, loadFindingHandoffs, onNavigateToChat]
  )

  const handleCloseTrackPicker = useCallback(() => {
    setShowTrackPicker(false)
  }, [])

  // "Fix in Chat" from selection tray — uses existing pendingFixContext pattern
  const handleFixInChat = useCallback(() => {
    if (selectedFindings.length === 0) return

    const findingsContext = selectedFindings
      .map(
        (f, i) =>
          `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n${f.description}` +
          (f.filePath ? `\n**File:** \`${f.filePath}\`` : '') +
          (f.recommendation ? `\n**Recommendation:** ${f.recommendation}` : '')
      )
      .join('\n\n')

    setPendingFixContext({
      title: `🔧 Fix ${selectedFindings.length} audit finding${selectedFindings.length > 1 ? 's' : ''}`,
      description: `The following audit findings need to be addressed:\n\n${findingsContext}\n\nPlease analyze these findings and create an implementation plan with ordered steps to fix them.`,
      autoSend: true,
      sourceAuditRunId: currentRun?.id
    })
    if (workspaceId) {
      void recordFindingHandoff({
        workspaceId,
        findingIds: selectedFindings.map((f) => f.id),
        target: 'chat'
      })
    }

    clearSelectedFindings()
    onFixInNewChat()
  }, [
    selectedFindings,
    currentRun,
    workspaceId,
    setPendingFixContext,
    recordFindingHandoff,
    clearSelectedFindings,
    onFixInNewChat
  ])

  // "Fix in Blueprint" from selection tray — one blueprint for the whole batch.
  // Unlike chat, the blueprint is created in the main process up front, so the
  // marker can point at the real blueprint id.
  const handleFixInBlueprint = useCallback(async () => {
    if (!workspaceId || selectedFindings.length === 0 || isHandingOff) return

    setIsHandingOff(true)
    setHandoffError(null)
    try {
      await handoffToBlueprint(
        workspaceId,
        selectedFindings.map((f) => f.id)
      )
      onNavigateToBlueprints?.()
    } catch (err) {
      console.error('[audit-handoff] Blueprint handoff failed:', err)
      // Silence here reads as a dead button — the batch cap in particular is
      // something the user can act on by selecting fewer findings.
      setHandoffError(
        err instanceof Error ? unwrapIpcError(err.message) : 'Could not create the blueprint.'
      )
    } finally {
      setIsHandingOff(false)
    }
  }, [workspaceId, selectedFindings, isHandingOff, handoffToBlueprint, onNavigateToBlueprints])

  return {
    showTrackPicker,
    isHandingOff,
    handoffError,
    trackPickerOptions,
    handleSendAllToChat,
    handleSplitByTrack,
    handleSplitConfirm,
    handleCloseTrackPicker,
    handleFixInChat,
    handleFixInBlueprint
  }
}

/**
 * useAuditHandoff — Orchestrates the Audit → Chat handoff flow.
 *
 * Provides handlers for:
 *   - "Send All to Chat" (consolidated mode)
 *   - "Split by Track" (opens track picker, then creates N conversations)
 *   - "Fix in Chat" from the selection tray (uses pendingFixContext pattern)
 */

import { useState, useCallback } from 'react'
import { useAuditStore } from '@renderer/store'
import { AUDIT_TRACKS } from '../../../../../shared/constants'
import type { AuditRun, AuditTrackId } from '../../../../../shared/types'
import {
  formatDirectFindings,
  formatConsolidatedPlan,
  buildHandoffTitle
} from '../../../utils/audit-handoff-formatter'

interface UseAuditHandoffResult {
  showTrackPicker: boolean
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
}

export function useAuditHandoff(
  workspaceId: string | undefined,
  currentRun: AuditRun | null,
  onFixInNewChat: () => void,
  onNavigateToChat?: () => void
): UseAuditHandoffResult {
  const [showTrackPicker, setShowTrackPicker] = useState(false)

  const { selectedFindings, clearSelectedFindings, setPendingFixContext } = useAuditStore()

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

    onFixInNewChat()
  }, [currentRun, workspaceId, setPendingFixContext, onFixInNewChat])

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
        // Navigate to chat — the sidebar will pick up new conversations
        onNavigateToChat?.()
      } catch (err) {
        console.error('[audit-handoff] Split handoff failed:', err)
      }
    },
    [workspaceId, currentRun, onNavigateToChat]
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
    clearSelectedFindings()
    onFixInNewChat()
  }, [selectedFindings, currentRun, setPendingFixContext, clearSelectedFindings, onFixInNewChat])

  return {
    showTrackPicker,
    trackPickerOptions,
    handleSendAllToChat,
    handleSplitByTrack,
    handleSplitConfirm,
    handleCloseTrackPicker,
    handleFixInChat
  }
}

/**
 * useAuditActionCallbacks — action callbacks for HealthPage (convert, fix, export, rerun, resume).
 * Extracted from useHealthPageState to reduce cyclomatic complexity.
 */
import { useCallback } from 'react'
import type { AuditFinding, AuditMode, AuditTrackId } from '../../../../../shared/types'

interface UseAuditActionCallbacksParams {
  workspaceId: string | undefined
  mode: AuditMode
  selectedFindings: AuditFinding[]
  currentRunMode: AuditMode | undefined
  setPendingFixContext: (ctx: { title: string; description: string }) => void
  clearSelectedFindings: () => void
  rerunTrack: (workspaceId: string, trackId: AuditTrackId, mode: AuditMode) => Promise<void>
  resumeAudit: (workspaceId: string) => Promise<void>
  onFixInNewChat: () => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useAuditActionCallbacks({
  workspaceId,
  mode,
  selectedFindings,
  currentRunMode,
  setPendingFixContext,
  clearSelectedFindings,
  rerunTrack,
  resumeAudit,
  onFixInNewChat
}: UseAuditActionCallbacksParams) {
  const handleConvert = useCallback(() => {
    const findings = [...selectedFindings]
    const findingsContext = findings
      .map((f, i) =>
        `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n${f.description}` +
        (f.filePath ? `\n**File:** \`${f.filePath}\`` : '') +
        (f.recommendation ? `\n**Recommendation:** ${f.recommendation}` : '')
      ).join('\n\n')
    setPendingFixContext({
      title: `🔧 Fix ${findings.length} audit finding${findings.length > 1 ? 's' : ''}`,
      description: `The following audit findings need to be addressed:\n\n${findingsContext}\n\nPlease analyze these findings and propose a plan to fix them.`
    })
    clearSelectedFindings()
    onFixInNewChat()
  }, [selectedFindings, setPendingFixContext, clearSelectedFindings, onFixInNewChat])

  const handleRerunTrack = useCallback(async (trackId: AuditTrackId) => {
    if (!workspaceId) return
    await rerunTrack(workspaceId, trackId, currentRunMode ?? mode)
  }, [workspaceId, rerunTrack, currentRunMode, mode])

  const handleExport = useCallback(async () => {
    if (!workspaceId) return
    try { await window.api.auditExportMarkdown({ workspaceId }) } catch { /* cancelled */ }
  }, [workspaceId])

  const handleExportPlan = useCallback(async () => {
    if (!workspaceId) return
    try { await window.api.auditExportPlanMarkdown({ workspaceId }) } catch { /* cancelled */ }
  }, [workspaceId])

  const handleAutoFix = useCallback((finding: AuditFinding, trackName: string) => {
    setPendingFixContext({
      title: `🔧 Fix: ${finding.title}`,
      description:
        `Please analyze this ${trackName} finding and suggest a specific fix:\n\n` +
        `**[${finding.severity.toUpperCase()}] ${finding.title}**\n` +
        `${finding.description}\n` +
        (finding.filePath ? `File: \`${finding.filePath}\`\n` : '') +
        (finding.recommendation ? `Recommendation: ${finding.recommendation}\n` : '') +
        `\nProvide the exact code changes needed to fix this issue.`
    })
    onFixInNewChat()
  }, [setPendingFixContext, onFixInNewChat])

  const handleResume = useCallback(async () => {
    if (!workspaceId) return
    try { await resumeAudit(workspaceId) } catch { /* logged in store */ }
  }, [workspaceId, resumeAudit])

  return {
    handleConvert,
    handleRerunTrack,
    handleExport,
    handleExportPlan,
    handleAutoFix,
    handleResume
  }
}

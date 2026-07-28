/**
 * AuditProvenanceBanner — Header banner shown at the top of the message list
 * when a conversation was created from a Health Audit handoff.
 *
 * Provides a "View Audit" link for bidirectional navigation.
 */

import { ShieldCheck, ArrowUpRight } from 'lucide-react'

interface AuditProvenanceBannerProps {
  auditRunId: string
  onViewAudit: () => void
}

export default function AuditProvenanceBanner({
  auditRunId: _auditRunId,
  onViewAudit
}: AuditProvenanceBannerProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-4 py-2 mx-4 mt-3 mb-2 rounded-lg bg-success/5 border border-success/20">
      <ShieldCheck size={14} className="text-success flex-shrink-0" />
      <span className="text-xs text-text-secondary">
        This conversation was created from a{' '}
        <span className="font-medium text-text-primary">Health Audit</span>
      </span>
      <button
        onClick={onViewAudit}
        className="ml-auto text-xs text-primary-text hover:text-primary-hover transition-colors flex items-center gap-1"
      >
        View Audit
        <ArrowUpRight size={11} />
      </button>
    </div>
  )
}

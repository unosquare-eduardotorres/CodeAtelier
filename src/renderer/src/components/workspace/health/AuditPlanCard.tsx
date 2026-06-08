/**
 * AuditPlanCard — renders a generated AuditPlan (title, summary, grouped
 * remediation items, risks) with a "Send to" route bar that hands the plan off
 * to Chat, Grill, Goals, Council, or Export.
 */

import {
  Wand2,
  MessageSquare,
  Flame,
  Target,
  Landmark,
  Download,
  AlertTriangle
} from 'lucide-react'
import type { AuditPlan } from '../../../../../shared/types'

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning/20 text-warning',
  low: 'bg-info/10 text-info',
  info: 'bg-surface-overlay text-text-secondary'
}

interface AuditPlanCardProps {
  plan: AuditPlan
  onSendToChat: () => void
  onSendToGrill: () => void
  onSendToGoals: () => void
  onSendToCouncil: () => void
  onExport: () => void
}

export default function AuditPlanCard({
  plan,
  onSendToChat,
  onSendToGrill,
  onSendToGoals,
  onSendToCouncil,
  onExport
}: AuditPlanCardProps): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {/* Header */}
        <div className="rounded-xl border border-primary/30 bg-primary-muted/15 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Wand2 size={16} className="text-primary-text" />
            <span className="text-[10px] font-semibold text-primary-text uppercase tracking-wider">
              Remediation Plan
            </span>
          </div>
          <h2 className="text-base font-bold text-text-primary">{plan.title}</h2>
          {plan.summary && (
            <p className="text-sm text-text-secondary mt-1.5 leading-relaxed">{plan.summary}</p>
          )}
          <p className="text-[11px] text-text-muted mt-2">
            {plan.items.length} item{plan.items.length !== 1 ? 's' : ''} ·{' '}
            {plan.sourceFindingIds.length} finding
            {plan.sourceFindingIds.length !== 1 ? 's' : ''} addressed
          </p>
        </div>

        {/* Items */}
        <div className="space-y-2.5">
          {plan.items.map((item, i) => (
            <div
              key={item.id}
              className="rounded-xl border border-border-subtle bg-surface-raised p-4"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono text-text-muted">{i + 1}.</span>
                <span className="text-sm font-semibold text-text-primary">{item.title}</span>
                {item.severity && (
                  <span
                    className={`px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded ${SEVERITY_COLORS[item.severity] ?? SEVERITY_COLORS.info}`}
                  >
                    {item.severity}
                  </span>
                )}
                <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-surface-overlay text-text-muted">
                  {item.scope}
                </span>
              </div>
              {item.description && (
                <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
                  {item.description}
                </p>
              )}
              {item.recommendation && (
                <p className="text-[11px] text-text-muted mt-1.5 italic">
                  💡 {item.recommendation}
                </p>
              )}
              {item.files.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {item.files.map((f) => (
                    <span
                      key={f}
                      className="px-1.5 py-0.5 text-[10px] font-mono bg-surface-overlay text-text-muted rounded truncate max-w-full"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Risks */}
        {plan.risks.length > 0 && (
          <div className="rounded-xl border border-warning/20 bg-warning/5 p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertTriangle size={14} className="text-warning" />
              <span className="text-xs font-semibold text-warning">Risks</span>
            </div>
            <ul className="space-y-1">
              {plan.risks.map((risk, i) => (
                <li key={i} className="text-xs text-text-secondary flex items-start gap-1.5">
                  <span className="text-warning mt-0.5">•</span>
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Route bar */}
      <div className="sticky bottom-0 border-t border-border-subtle bg-surface-raised px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] text-text-muted">Send this plan to:</span>
          <div className="flex items-center gap-2 flex-wrap">
            <RouteButton icon={MessageSquare} label="Chat" onClick={onSendToChat} />
            <RouteButton icon={Flame} label="Grill" onClick={onSendToGrill} />
            <RouteButton icon={Target} label="Goals" onClick={onSendToGoals} />
            <RouteButton icon={Landmark} label="Council" onClick={onSendToCouncil} />
            <RouteButton icon={Download} label="Export" onClick={onExport} />
          </div>
        </div>
      </div>
    </div>
  )
}

function RouteButton({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof MessageSquare
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

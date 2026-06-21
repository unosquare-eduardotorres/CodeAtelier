/**
 * GrillDecisionsView — structured decisions review + requirement document preview.
 *
 * Shows all Q→A decisions grouped by iteration/track, the assembled requirement
 * document, and a "Condense with AI" button for long documents (> 15,000 chars).
 */

import { useState, useCallback, useMemo } from 'react'
import { FileText, ChevronDown, ChevronRight } from 'lucide-react'
import type { DecisionEntry, GrillTrackId } from '../../../../shared/types'
import { GRILL_TRACKS } from '../../../../shared/constants'
import RequirementDocumentPanel from './grill/RequirementDocumentPanel'

// ── Props ───────────────────────────────────────────────────────────────────

interface GrillDecisionsViewProps {
  /** Original idea description — pinned at top */
  ideaDescription: string
  ideaTitle: string
  /** All Q→A decisions from history */
  decisions: DecisionEntry[]
  /** Full assembled requirement document text */
  requirementDocument: string
  /** Called when the user wants to condense — parent orchestrates via IPC */
  onCondense: () => Promise<void>
  /** Condensed text (if available) */
  condensedDocument?: string
  /** Whether condensation is in progress */
  isCondensing?: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Group decisions by iteration + track */
function groupDecisions(
  decisions: DecisionEntry[]
): Map<
  string,
  { iteration: number; trackId?: GrillTrackId; score?: number; items: DecisionEntry[] }
> {
  const groups = new Map<
    string,
    { iteration: number; trackId?: GrillTrackId; score?: number; items: DecisionEntry[] }
  >()

  for (const d of decisions) {
    const key = `${d.iteration}-${d.trackId ?? 'general'}`
    if (!groups.has(key)) {
      groups.set(key, { iteration: d.iteration, trackId: d.trackId, score: d.score, items: [] })
    }
    groups.get(key)!.items.push(d)
  }

  return groups
}

// ── Component ───────────────────────────────────────────────────────────────

export default function GrillDecisionsView({
  ideaDescription,
  ideaTitle,
  decisions,
  requirementDocument,
  onCondense,
  condensedDocument,
  isCondensing
}: GrillDecisionsViewProps): React.JSX.Element {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const grouped = useMemo(() => groupDecisions(decisions), [decisions])

  // Auto-expand all groups initially
  const allGroupKeys = useMemo(() => Array.from(grouped.keys()), [grouped])

  // If expandedGroups is empty, treat all as expanded (default open)
  const isExpanded = useCallback(
    (key: string) => expandedGroups.size === 0 || expandedGroups.has(key),
    [expandedGroups]
  )

  const toggleGroup = useCallback(
    (key: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        // If first toggle (all were open by default), initialize with all except the toggled one
        if (prev.size === 0) {
          for (const k of allGroupKeys) {
            if (k !== key) next.add(k)
          }
          return next
        }
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
    },
    [allGroupKeys]
  )

  return (
    <div data-testid="grill-decisions-view" className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Original idea description — pinned context */}
        <div className="rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
          <div className="px-4 py-2.5 bg-surface-base/60 border-b border-border-subtle">
            <span className="text-sm font-semibold text-text-primary">{ideaTitle}</span>
          </div>
          <div className="px-4 py-3">
            <p className="text-sm text-text-body whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
              {ideaDescription || 'No description provided.'}
            </p>
          </div>
        </div>

        {/* Decisions grouped by iteration/track */}
        {decisions.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">
            No decisions yet — complete at least one iteration in the Chat tab.
          </div>
        ) : (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <FileText size={14} className="text-accent" />
              Decisions ({decisions.length})
            </h3>

            {Array.from(grouped.entries()).map(([key, group]) => {
              const trackMeta = group.trackId ? GRILL_TRACKS[group.trackId] : null
              const expanded = isExpanded(key)

              return (
                <div
                  key={key}
                  className="rounded-lg border border-border-subtle bg-surface-overlay overflow-hidden"
                >
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(key)}
                    className="w-full px-4 py-2.5 flex items-center gap-2 bg-surface-base/40 hover:bg-surface-base/60 transition-colors text-left"
                  >
                    {expanded ? (
                      <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
                    ) : (
                      <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      Iteration {group.iteration}
                    </span>
                    {trackMeta && (
                      <>
                        <span className="text-text-muted">·</span>
                        <span className="text-xs text-accent font-medium">{trackMeta.name}</span>
                      </>
                    )}
                    {group.score != null && (
                      <>
                        <span className="text-text-muted">·</span>
                        <span className="text-xs font-medium text-text-secondary">
                          {group.score}/100
                        </span>
                      </>
                    )}
                    <span className="text-xs text-text-muted ml-auto">
                      {group.items.length} decision{group.items.length !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {/* Decision cards */}
                  {expanded && (
                    <div className="divide-y divide-border-subtle">
                      {group.items.map((d, idx) => (
                        <div key={`${key}-${idx}`} className="px-4 py-3">
                          <div className="text-xs font-medium text-text-secondary mb-1">
                            Q: {d.question}
                          </div>
                          {d.questionFull && (
                            <p className="text-xs text-text-muted mb-1.5 leading-relaxed italic">
                              {d.questionFull}
                            </p>
                          )}
                          <div className="text-sm text-text-body">A: {d.answer}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Requirement Document preview */}
        {requirementDocument && (
          <RequirementDocumentPanel
            text={requirementDocument}
            condensedDocument={condensedDocument}
            onCondense={onCondense}
            isCondensing={isCondensing}
          />
        )}
      </div>
    </div>
  )
}

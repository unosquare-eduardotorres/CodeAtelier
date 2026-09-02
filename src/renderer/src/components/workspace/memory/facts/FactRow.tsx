import { useState } from 'react'
import {
  Archive,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderTree,
  Globe,
  MoreHorizontal,
  Trash2,
  TrendingUp
} from 'lucide-react'

import { ConfirmDialog } from '@renderer/components/common'
import { Meter, Popover, Tooltip } from '@renderer/components/common/ui'
import { CATEGORY_META } from '../category-meta'
import { TIER_DOT, TIER_LABELS, TIER_TEXT, relativeDate } from './types'
import type { MemoryFact, MemoryFactTier } from '../../../../../../shared/types'

export interface FactRowHandlers {
  onConfirm?: (id: string) => void
  /** Manual tier bump — the escape hatch when evidence gates lag reality. */
  onPromote?: (id: string, tier: MemoryFactTier) => void
  onArchive?: (id: string) => void
  onDelete?: (id: string) => void
  onScopeToggle?: (fact: MemoryFact) => void
  onScopePathsChange?: (id: string, paths: string[]) => void
}

interface FactRowProps extends FactRowHandlers {
  fact: MemoryFact
  expanded: boolean
  onToggleExpand: () => void
  dimmed?: boolean
}

/** Labelled key/value instead of the old 10px run-on metadata line. */
function MetaField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-xs text-text-secondary truncate">{children}</div>
    </div>
  )
}

/**
 * One memory. Compact by default (a single ~34px line), expanding in place to
 * the full content, metadata and scope editor.
 *
 * Actions live in an always-present overflow menu rather than `opacity-0`
 * buttons, which stayed focusable and clickable while invisible.
 */
export default function FactRow({
  fact,
  expanded,
  onToggleExpand,
  dimmed,
  onConfirm,
  onPromote,
  onArchive,
  onDelete,
  onScopeToggle,
  onScopePathsChange
}: FactRowProps): React.JSX.Element {
  const [showArchiveDialog, setShowArchiveDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [scopeDraft, setScopeDraft] = useState<string | null>(null)

  const tier = Math.min(fact.tier, 3)
  const category = CATEGORY_META[fact.category]

  const commitScope = (): void => {
    if (scopeDraft === null) return
    const paths = scopeDraft
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    setScopeDraft(null)
    if (paths.join(',') !== fact.scopePaths.join(',')) onScopePathsChange?.(fact.id, paths)
  }

  return (
    <>
      <div
        className={`rounded-md border transition-colors ${
          expanded
            ? 'border-border-strong bg-surface-overlay/40'
            : 'border-transparent hover:border-border-default hover:bg-surface-overlay/30'
        } ${dimmed ? 'opacity-60' : ''}`}
      >
        {/* ── Compact line ── */}
        <div className="flex items-center gap-2 h-9 px-2">
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="flex items-center gap-2 flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus rounded"
          >
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-muted" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-muted" />
            )}
            <Tooltip content={`${TIER_LABELS[tier]} · ${Math.round(fact.confidence * 100)}%`}>
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${TIER_DOT[tier]}`}
                aria-label={TIER_LABELS[tier]}
              />
            </Tooltip>
            <span className="text-sm text-text-primary truncate">{fact.title}</span>
          </button>

          <span className={`shrink-0 px-1.5 py-0.5 text-[11px] rounded ${category.color}`}>
            {category.label}
          </span>

          {fact.embeddingPending && (
            <Tooltip content="Waiting to be embedded — not yet searchable semantically">
              <Clock className="w-3.5 h-3.5 text-warning shrink-0" />
            </Tooltip>
          )}

          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted w-16 text-right">
            {relativeDate(fact.createdAt)}
          </span>

          <Popover
            align="end"
            className="w-44 p-1"
            trigger={(props) => (
              <button
                type="button"
                aria-label={`Actions for ${fact.title}`}
                {...props}
                className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-float focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            )}
          >
            <ul role="menu" className="py-0.5">
              {onConfirm && fact.status === 'active' && (
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onConfirm(fact.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-text-secondary hover:bg-surface-overlay hover:text-success"
                  >
                    <CheckCircle className="w-3.5 h-3.5" /> Confirm
                  </button>
                </li>
              )}
              {onPromote && fact.status === 'active' && fact.tier < 3 && !fact.volatile && (
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onPromote(fact.id, (fact.tier + 1) as MemoryFactTier)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-text-secondary hover:bg-surface-overlay hover:text-info"
                  >
                    <TrendingUp className="w-3.5 h-3.5" /> Promote to {TIER_LABELS[tier + 1]}
                  </button>
                </li>
              )}
              {onScopeToggle && (
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onScopeToggle(fact)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-text-secondary hover:bg-surface-overlay hover:text-info"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    {fact.workspaceId ? 'Make global' : 'Scope to workspace'}
                  </button>
                </li>
              )}
              {onArchive && fact.status === 'active' && (
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setShowArchiveDialog(true)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-text-secondary hover:bg-surface-overlay hover:text-warning"
                  >
                    <Archive className="w-3.5 h-3.5" /> Archive
                  </button>
                </li>
              )}
              {onDelete && (
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setShowDeleteDialog(true)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-text-secondary hover:bg-surface-overlay hover:text-danger"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </li>
              )}
            </ul>
          </Popover>
        </div>

        {/* ── Expanded detail ── */}
        {expanded && (
          <div className="px-2 pb-3 pl-7 space-y-3">
            <p className="text-xs text-text-secondary leading-relaxed max-w-prose">
              {fact.content}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetaField label="Source">
                {fact.sourceType}
                {fact.sourceRef ? ` · ${fact.sourceRef.slice(0, 24)}` : ''}
              </MetaField>
              <MetaField label="Tier">
                <span className={`font-mono ${TIER_TEXT[tier]}`}>{TIER_LABELS[tier]}</span>
              </MetaField>
              <MetaField label="Confidence">
                <Meter
                  value={fact.confidence}
                  tone={tier >= 2 ? 'success' : 'info'}
                  label={`${Math.round(fact.confidence * 100)}%`}
                />
              </MetaField>
              <MetaField label="Confirms">
                <span className="font-mono tabular-nums">{fact.confirmationCount}</span>
              </MetaField>
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wider text-text-muted mb-1">Scope</div>
              {scopeDraft !== null ? (
                <input
                  autoFocus
                  value={scopeDraft}
                  onChange={(e) => setScopeDraft(e.target.value)}
                  onBlur={commitScope}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitScope()
                    if (e.key === 'Escape') setScopeDraft(null)
                  }}
                  placeholder="src/api/**, src/db"
                  aria-label="Scope globs, comma separated"
                  className="w-full max-w-md bg-input-bg border border-border-strong rounded px-2 py-1 text-xs text-text-primary"
                />
              ) : onScopePathsChange ? (
                <button
                  type="button"
                  onClick={() => setScopeDraft(fact.scopePaths.join(', '))}
                  className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-info transition-colors"
                  title="Paths this memory applies to — it is injected whenever you work on them"
                >
                  <FolderTree className="w-3.5 h-3.5" />
                  {fact.scopePaths.length > 0 ? fact.scopePaths.join(', ') : 'Add scope'}
                </button>
              ) : (
                <span className="text-xs text-text-secondary">
                  {fact.scopePaths.length > 0 ? fact.scopePaths.join(', ') : '—'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={showArchiveDialog}
        title="Archive Memory"
        message={`Archive "${fact.title}"? This hides it from retrieval but can be reversed.`}
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          setShowArchiveDialog(false)
          onArchive?.(fact.id)
        }}
        onCancel={() => setShowArchiveDialog(false)}
      />

      <ConfirmDialog
        isOpen={showDeleteDialog}
        title="Delete Memory Permanently"
        message={`Delete "${fact.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowDeleteDialog(false)
          onDelete?.(fact.id)
        }}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </>
  )
}

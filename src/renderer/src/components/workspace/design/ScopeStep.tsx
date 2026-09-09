/**
 * ScopeStep — step 3 of the design wizard: what to look at, and with which provider.
 *
 * Defaults to the directory `design:scopeTree` derived as densest (P4.0).
 * Whole-project stays available, but only as an explicit opt-in carrying the
 * P3.7.9 measurement: on this repo a project-wide deterministic scan took 37.8s
 * and produced 4283 findings, 98% of them from generated build output. A
 * project-scope *default* would flood every remediation brief with findings
 * about coverage reports.
 */

import { Cloud, Monitor, FolderTree, AlertTriangle, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DesignScopeTree, LLMProvider } from '../../../../../shared/types'

/** Sentinel for whole-project scope in the select. Not a path, so it cannot collide. */
export const WHOLE_PROJECT = '__project__'

interface ScopeStepProps {
  scopeTree: DesignScopeTree | null
  scopeChoice: string
  onScopeChange: (choice: string) => void
  provider: LLMProvider
  onProviderChange: (provider: LLMProvider) => void
}

export default function ScopeStep({
  scopeTree,
  scopeChoice,
  onScopeChange,
  provider,
  onProviderChange
}: ScopeStepProps): React.JSX.Element {
  const isWholeProject = scopeChoice === WHOLE_PROJECT
  const isSuggested = scopeTree?.suggested === scopeChoice

  return (
    <div data-testid="design-scope-step" className="max-w-2xl mx-auto px-6 py-6 space-y-8">
      <section>
        <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1">
          Scope
        </h3>
        <p className="text-[11px] text-text-muted mb-3">
          Only files a design pass can act on are counted — markup, styles and components.
        </p>

        {scopeTree === null ? (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            Scanning the workspace…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <FolderTree size={14} className="text-text-muted shrink-0" />
              <select
                data-testid="design-scope-select"
                value={scopeChoice}
                onChange={(e) => onScopeChange(e.target.value)}
                aria-label="Design review scope"
                className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value={WHOLE_PROJECT}>Whole project ({scopeTree.totalFiles} files)</option>
                {scopeTree.dirs.map((dir) => (
                  <option key={dir.path} value={dir.path}>
                    {dir.path} ({dir.fileCount} files)
                  </option>
                ))}
              </select>
            </div>

            {isSuggested && (
              <p className="text-[11px] text-text-muted mt-2">
                Suggested — the densest concentration of design files in this workspace.
              </p>
            )}

            {isWholeProject && scopeTree.totalFiles > 0 && (
              <p
                data-testid="design-scope-warning"
                className="flex items-start gap-1.5 text-[11px] text-warning mt-2"
              >
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                Slow and noisy. The deterministic scan alone took ~38s and returned thousands of
                findings on a repo this size, most of them from generated build output. A single
                directory is the better first pass.
              </p>
            )}

            {scopeTree.totalFiles === 0 && (
              <p className="flex items-start gap-1.5 text-[11px] text-warning mt-2">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                No design-relevant files found in this workspace — a review would have nothing to
                look at.
              </p>
            )}

            {scopeTree.truncated && (
              <p className="text-[10px] text-text-muted mt-2">
                Showing the {scopeTree.dirs.length} densest directories.
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
          Provider
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <ProviderButton
            active={provider === 'claude'}
            icon={Cloud}
            label="Claude"
            onClick={() => onProviderChange('claude')}
          />
          <ProviderButton
            active={provider === 'local-llm'}
            icon={Monitor}
            label="Local LLM"
            onClick={() => onProviderChange('local-llm')}
          />
        </div>
      </section>
    </div>
  )
}

function ProviderButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all ${
        active
          ? 'border-primary bg-primary-muted/40'
          : 'border-border-subtle hover:border-primary/30 hover:bg-surface-overlay'
      }`}
    >
      <Icon size={18} className={active ? 'text-primary-text' : 'text-text-muted'} />
      <span
        className={`text-sm font-medium ${active ? 'text-primary-text' : 'text-text-secondary'}`}
      >
        {label}
      </span>
    </button>
  )
}

import { useState } from 'react'
import {
  Check,
  RefreshCw,
  Network,
  Info,
  ChevronDown,
  ChevronRight,
  TriangleAlert
} from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { ToggleRow } from '../settings-sections'
import CodeGraphProgressPanel from '../CodeGraphProgressPanel'
import type { CodeGraphIndexingState } from '../../../../../shared/types'

interface CodeGraphCardProps {
  workspaceId: string
  enabled: boolean
  codeGraphState: CodeGraphIndexingState | null
  codeGraphJustEnabled: boolean
  onToggle: (enabled: boolean) => Promise<void>
}

export default function CodeGraphCard({
  workspaceId,
  enabled,
  codeGraphState,
  codeGraphJustEnabled,
  onToggle
}: CodeGraphCardProps): React.JSX.Element {
  const [isReindexing, setIsReindexing] = useState(false)
  const [showWhyInfo, setShowWhyInfo] = useState(false)

  const handleReindex = async (): Promise<void> => {
    setIsReindexing(true)
    try {
      await window.api.codeGraphIndexStart({ workspaceId })
    } catch {
      // Progress panel will surface errors
    }
    setIsReindexing(false)
  }

  // Derive stats from the code graph state
  const isComplete = codeGraphState?.status === 'complete'
  const hasStats = isComplete && codeGraphState

  return (
    <SettingsCard>
      <ToggleRow
        label="Code Graph"
        description="Index the codebase with Tree-sitter + PageRank for structural code navigation."
        checked={enabled}
        onChange={onToggle}
      />

      {/* Guard-rail degradation warning — a frozen graph must never look healthy */}
      {codeGraphState?.degraded && (
        <div className="flex items-start gap-2 text-xs bg-warning-muted border border-warning/40 rounded-md p-3 ml-0.5 mt-2">
          <TriangleAlert size={12} className="text-warning shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-text-body">Dependency graph is stale</p>
            <p className="text-text-secondary">{codeGraphState.degradedReason}</p>
            <p className="text-text-muted">
              Add vendored and generated directories to <code>.atelierignore</code> at the workspace
              root, then Re-index.
            </p>
          </div>
        </div>
      )}

      {/* Expandable "Why use Code Graph?" info section */}
      <button
        onClick={() => setShowWhyInfo(!showWhyInfo)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors ml-0.5 mt-1"
      >
        {showWhyInfo ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Info size={10} />
        <span>Why use Code Graph?</span>
      </button>
      {showWhyInfo && (
        <div className="text-xs text-text-secondary bg-surface-base rounded-md p-3 ml-0.5 space-y-2 border border-border-subtle">
          <p className="font-medium text-text-body">What you get:</p>
          <ul className="list-disc list-inside space-y-0.5 text-text-secondary">
            <li>
              <strong className="text-text-body">Jump to definition</strong> — find where any
              function, class, or variable is defined
            </li>
            <li>
              <strong className="text-text-body">Find all callers</strong> — trace who calls a
              function across the entire codebase
            </li>
            <li>
              <strong className="text-text-body">Find references</strong> — see every usage of a
              symbol (imports, annotations, call-sites)
            </li>
            <li>
              <strong className="text-text-body">File dependencies</strong> — understand module
              coupling and circular dependency risks
            </li>
            <li>
              <strong className="text-text-body">Dead code detection</strong> — surface unused
              exports and unreachable functions
            </li>
            <li>
              <strong className="text-text-body">Symbol hotspots</strong> — identify the
              most-connected symbols in your codebase
            </li>
          </ul>
          <p>
            <strong className="text-text-body">Performance:</strong> Tree-sitter parsing + PageRank
            analysis. Indexing a 1,000-file project takes ~5–10 seconds. Results are persisted to
            SQLite — instant on next startup.
          </p>
          <p>
            <strong className="text-text-body">Example:</strong> Your agent can run{' '}
            <code className="text-text-muted bg-surface-overlay px-1 py-0.5 rounded text-[10px]">
              find_callers(&quot;handleSubmit&quot;)
            </code>{' '}
            and instantly see every component and test that calls that function, without grepping
            through files.
          </p>
        </div>
      )}

      {codeGraphJustEnabled && (
        <div className="flex items-center gap-2 text-xs text-success mt-2 pl-1">
          <Check size={12} />
          <span>
            Code Graph enabled — agents will use Tree-sitter navigation in their next session.
          </span>
        </div>
      )}

      {enabled && (
        <>
          {/* Stats row */}
          {hasStats && (
            <div className="flex items-center gap-4 mt-3 pl-1">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Network size={12} className="text-primary" />
                <span>
                  {codeGraphState.totalFiles.toLocaleString()} files ·{' '}
                  {codeGraphState.totalTags.toLocaleString()} tags ·{' '}
                  {codeGraphState.totalEdges.toLocaleString()} edges
                </span>
              </div>
            </div>
          )}

          {/* Progress panel (auto-shows when indexing is active) */}
          <CodeGraphProgressPanel workspaceId={workspaceId} />

          {/* Re-index button */}
          <div className="mt-3 pl-1">
            <button
              onClick={handleReindex}
              disabled={isReindexing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} className={isReindexing ? 'animate-spin' : ''} />
              Re-index Code Graph
            </button>
          </div>
        </>
      )}
    </SettingsCard>
  )
}

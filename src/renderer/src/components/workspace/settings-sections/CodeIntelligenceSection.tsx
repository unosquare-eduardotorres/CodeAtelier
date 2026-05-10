/**
 * @deprecated Moved to src/renderer/src/components/workspace/code-intelligence/.
 * This file is kept for reference but is no longer imported anywhere.
 * Use CodeGraphCard, SemanticSearchCard, EmbeddingModelCard, and SearchPlayground instead.
 */
import React, { useState } from 'react'
import {
  Check,
  Loader2,
  Search,
  Database,
  RefreshCw,
  Info,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { EmbeddingModelStatus } from '../../../../../shared/types'
import ToggleRow from './ToggleRow'
import IndexingProgressPanel from '../IndexingProgressPanel'
import CodeGraphProgressPanel from '../CodeGraphProgressPanel'

interface CodeIntelligenceSectionProps {
  workspaceId: string
  settings: Record<string, unknown>
  embeddingStatus: EmbeddingModelStatus | null
  persistedIndexStatus: { loaded: boolean; symbolCount?: number; loading: boolean }
  codeGraphJustEnabled: boolean
  onToggle: (key: string, value: boolean) => Promise<void>
  onCodeGraphToggle: (enabled: boolean) => Promise<void>
  onSemanticSearchToggle: (enabled: boolean) => Promise<void>
  onStartIndex: () => Promise<void>
  isStartingIndex: boolean
  onShowEmbeddingSetup: () => void
}

export default function CodeIntelligenceSection({
  workspaceId,
  settings,
  embeddingStatus,
  persistedIndexStatus,
  codeGraphJustEnabled,
  onToggle,
  onCodeGraphToggle,
  onSemanticSearchToggle,
  onStartIndex,
  isStartingIndex,
  onShowEmbeddingSetup
}: CodeIntelligenceSectionProps): React.JSX.Element {
  const [showAiDescInfo, setShowAiDescInfo] = useState(false)

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          Code Intelligence
        </h3>
        {!!settings.repomapEnabled && (
          <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
            <Check size={10} /> Active
          </span>
        )}
      </div>
      <SettingsCard className="divide-y divide-border-subtle">
        <div className="py-3 first:pt-0 last:pb-0">
          <ToggleRow
            label="Code Graph (repomap)"
            description="Index the codebase with Tree-sitter + PageRank for structural code navigation."
            checked={!!settings.repomapEnabled}
            onChange={onCodeGraphToggle}
          />
          {codeGraphJustEnabled && (
            <div className="flex items-center gap-2 text-xs text-success mt-2 pl-1">
              <Check size={12} />
              <span>
                Code Graph enabled — agents will use Tree-sitter navigation in their next session.
              </span>
            </div>
          )}

          {/* Progress panel (auto-shows when indexing is active) */}
          {!!settings.repomapEnabled && (
            <CodeGraphProgressPanel workspaceId={workspaceId} />
          )}

          {/* Re-index button (shown when enabled) */}
          {!!settings.repomapEnabled && (
            <div className="mt-2 pl-1">
              <button
                onClick={async () => {
                  await window.api.codeGraphIndexStart({ workspaceId })
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 rounded-md transition-colors"
              >
                <RefreshCw size={12} />
                Re-index Code Graph
              </button>
            </div>
          )}
        </div>

        {/* Semantic Search */}
        <div className="py-3 first:pt-0 last:pb-0">
          <ToggleRow
            label="Semantic Search"
            description="Enable natural language code search using local embeddings (no external tools required)."
            checked={!!settings.semanticSearchEnabled}
            onChange={onSemanticSearchToggle}
          />
        </div>

        {/* Semantic search sub-settings (shown when enabled) */}
        {!!settings.semanticSearchEnabled && (
          <div className="py-3 space-y-3 border-t border-border-subtle">
            {/* Embedding model status badge */}
            <div className="flex items-center gap-2">
              <Search size={12} className="text-text-secondary" />
              <span className="text-xs text-text-secondary">Embedding model:</span>
              {embeddingStatus?.ready ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <Check size={10} />
                  Ready
                </span>
              ) : embeddingStatus?.cached ? (
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Check size={10} />
                  Cached (loads on first use)
                </span>
              ) : (
                <button
                  onClick={onShowEmbeddingSetup}
                  className="text-xs text-primary hover:text-primary-hover flex items-center gap-1"
                >
                  <Info size={10} />
                  Not downloaded — click to set up
                </button>
              )}
            </div>

            {/* AI Descriptions toggle */}
            <div className="pl-1 space-y-2">
              <ToggleRow
                label="AI Descriptions"
                description="Enrich each code symbol with a plain English summary before embedding."
                checked={!!settings.semanticSearchDescriptions}
                onChange={(v) => onToggle('semanticSearchDescriptions', v)}
              />
              {/* Expandable info section */}
              <button
                onClick={() => setShowAiDescInfo(!showAiDescInfo)}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors ml-0.5"
              >
                {showAiDescInfo ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                <Info size={10} />
                <span>Why enable this?</span>
              </button>
              {showAiDescInfo && (
                <div className="text-xs text-text-secondary bg-surface-base rounded-md p-3 ml-0.5 space-y-2 border border-border-subtle">
                  <p>
                    <strong className="text-text-body">What it does:</strong> During indexing,
                    each code chunk (function, class, method) is sent to Claude Haiku which
                    generates a one-line natural language description — e.g.{' '}
                    <span className="italic text-text-muted">
                      &quot;Validates JWT tokens and extracts user claims from the authorization
                      header&quot;
                    </span>
                    . This description is embedded alongside the raw code.
                  </p>
                  <p>
                    <strong className="text-text-body">Why it helps:</strong> Raw code embeddings
                    match well for literal searches, but struggle with intent-based queries. When
                    you search{' '}
                    <span className="italic text-text-muted">
                      &quot;how does authentication work?&quot;
                    </span>
                    , the AI-generated description matches far more accurately than the raw{' '}
                    <code className="text-[10px] bg-surface-raised px-1 py-0.5 rounded">
                      validateJwt()
                    </code>{' '}
                    function body alone. Expect noticeably better semantic search recall.
                  </p>
                  <p>
                    <strong className="text-text-body">Tradeoff:</strong> Indexing takes longer
                    and uses Claude Haiku tokens from your subscription (one short call per code
                    symbol). Descriptions are cached — re-indexing only regenerates changed files.
                  </p>
                </div>
              )}
            </div>

            {/* Persisted index status */}
            <div className="pl-1">
              {persistedIndexStatus.loading ? (
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Loading cached index...</span>
                </div>
              ) : persistedIndexStatus.loaded ? (
                <div className="flex items-center gap-2 text-xs text-success">
                  <Database size={12} />
                  <span>
                    Index loaded from cache (
                    {persistedIndexStatus.symbolCount?.toLocaleString()} symbols)
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Database size={12} />
                  <span>No cached index — click below to start indexing</span>
                </div>
              )}
            </div>

            {/* Start / Re-index button — always available when semantic search is enabled */}
            <div className="pl-1">
              <button
                onClick={onStartIndex}
                disabled={isStartingIndex}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary bg-primary/10 border border-primary/30 hover:bg-primary/20 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isStartingIndex ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : persistedIndexStatus.loaded ? (
                  <RefreshCw size={12} />
                ) : (
                  <Search size={12} />
                )}
                {isStartingIndex
                  ? 'Starting…'
                  : persistedIndexStatus.loaded
                    ? 'Re-index'
                    : 'Start Indexing'}
              </button>
              <p className="text-xs text-text-muted mt-1">
                {persistedIndexStatus.loaded
                  ? 'Rebuild the semantic search index from scratch.'
                  : 'Scan the codebase and build the semantic search index.'}
              </p>
            </div>

            {/* Indexing progress */}
            <IndexingProgressPanel workspaceId={workspaceId} />
          </div>
        )}
      </SettingsCard>
    </section>
  )
}

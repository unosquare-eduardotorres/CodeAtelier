import { useState } from 'react'
import { Search, RefreshCw, Loader2, Database, Info, ChevronDown, ChevronRight } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { ToggleRow } from '../settings-sections'
import IndexingProgressPanel from '../IndexingProgressPanel'
import type { EmbeddingModelStatus } from '../../../../../shared/types'

interface SemanticSearchCardProps {
  workspaceId: string
  enabled: boolean
  settings: Record<string, unknown>
  embeddingStatus: EmbeddingModelStatus | null
  persistedIndexStatus: { loaded: boolean; symbolCount?: number; loading: boolean }
  isStartingIndex: boolean
  isAppleSilicon: boolean | null // null = loading
  onToggle: (enabled: boolean) => Promise<void>
  onSettingToggle: (key: string, value: boolean) => Promise<void>
  onStartIndex: () => Promise<void>
  onNavigateToModels: () => void
}

export default function SemanticSearchCard({
  workspaceId,
  enabled,
  settings,
  embeddingStatus,
  persistedIndexStatus,
  isStartingIndex,
  isAppleSilicon,
  onToggle,
  onSettingToggle,
  onStartIndex,
  onNavigateToModels
}: SemanticSearchCardProps): React.JSX.Element {
  const [showWhyInfo, setShowWhyInfo] = useState(false)
  const [showAiDescInfo, setShowAiDescInfo] = useState(false)

  // Ollama provides an alternative embedding backend on non-Apple Silicon platforms
  const hasOllamaEmbedding = embeddingStatus?.backend === 'ollama' && embeddingStatus?.ollamaRunning
  const embeddingUnavailable = isAppleSilicon === false && !hasOllamaEmbedding

  // Resolve display label for the active embedding backend
  const backendLabel = embeddingStatus?.backend === 'ollama'
    ? (embeddingStatus.ollamaEmbeddingModel ?? 'Ollama')
    : (embeddingStatus?.omlxEmbeddingModelId ?? 'oMLX')

  return (
    <SettingsCard className="space-y-3">
      <ToggleRow
        label="Semantic Search"
        description="Natural language code search using local embeddings (requires oMLX or Ollama running with an embedding model)."
        checked={enabled}
        onChange={onToggle}
      />

      {/* Expandable "Why use Semantic Search?" info section */}
      <button
        onClick={() => setShowWhyInfo(!showWhyInfo)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors ml-0.5 mt-1"
      >
        {showWhyInfo ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Info size={10} />
        <span>Why use Semantic Search?</span>
      </button>
      {showWhyInfo && (
        <div className="text-xs text-text-secondary bg-surface-base rounded-md p-3 ml-0.5 space-y-2 border border-border-subtle">
          <p className="font-medium text-text-body">What you get:</p>
          <ul className="list-disc list-inside space-y-0.5 text-text-secondary">
            <li>
              <strong className="text-text-body">Natural language search</strong> — ask{' '}
              <span className="italic text-text-muted">
                &quot;how does authentication work?&quot;
              </span>{' '}
              instead of grepping for specific function names
            </li>
            <li>
              <strong className="text-text-body">Concept discovery</strong> — find related code
              across the codebase by meaning, not just text matching (e.g.{' '}
              <span className="italic text-text-muted">&quot;error handling&quot;</span> finds
              try/catch blocks, error boundaries, and validation logic)
            </li>
            <li>
              <strong className="text-text-body">Similar code detection</strong> — find code that
              does similar things even with different naming conventions
            </li>
          </ul>
          <p>
            <strong className="text-text-body">How it works:</strong> Your code is split into
            semantic chunks (functions, classes, methods), embedded as vectors using a local AI
            model running in oMLX (e.g. BGE-M3), and stored for instant similarity search. No data
            leaves your machine.
          </p>
          <p>
            <strong className="text-text-body">Example:</strong> Searching{' '}
            <span className="italic text-text-muted">&quot;database connection pooling&quot;</span>{' '}
            surfaces your pool config, retry logic, and health check code — even if none of those
            files mention &quot;pooling&quot; by name.
          </p>
        </div>
      )}

      {enabled && (
        <div className="space-y-3 pt-2 border-t border-border-subtle">
          {/* Stats row */}
          {persistedIndexStatus.loaded && (
            <div className="flex items-center gap-4 pl-1">
              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <Database size={12} className="text-primary" />
                <span>
                  {persistedIndexStatus.symbolCount?.toLocaleString()} chunks · {embeddingStatus?.backend === 'ollama' ? 'Ollama' : 'oMLX'} embedding
                </span>
              </div>
            </div>
          )}

          {/* Embedding model status badge */}
          {!persistedIndexStatus.loaded && (
            <div className="flex items-center gap-2 pl-1">
              <Search size={12} className="text-text-secondary" />
              <span className="text-xs text-text-secondary">Embedding model:</span>
              {embeddingStatus?.ready ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <span className="w-1.5 h-1.5 rounded-full bg-success" />
                  Ready ({backendLabel})
                </span>
              ) : hasOllamaEmbedding ? (
                <span className="text-xs text-warning">Ollama running — no embedding model selected</span>
              ) : embeddingStatus?.omlxRunning ? (
                <span className="text-xs text-warning">oMLX running — no embedding model loaded</span>
              ) : embeddingUnavailable ? (
                <span className="text-xs text-text-muted">
                  Configure Ollama with an embedding model in Models →
                </span>
              ) : (
                <button
                  onClick={onNavigateToModels}
                  className="text-xs text-primary hover:text-primary-hover flex items-center gap-1"
                >
                  <Info size={10} />
                  Embedding model not configured — go to Models →
                </button>
              )}
            </div>
          )}

          {/* AI Descriptions sub-toggle */}
          <div className="pl-1 space-y-2">
            <ToggleRow
              label="AI Descriptions (Claude Haiku)"
              description="Enrich each code symbol with a plain English summary before embedding."
              checked={!!settings.semanticSearchDescriptions}
              onChange={(v) => onSettingToggle('semanticSearchDescriptions', v)}
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
                  <strong className="text-text-body">What it does:</strong> During indexing, each
                  code chunk (function, class, method) is sent to Claude Haiku which generates a
                  one-line natural language description. This description is embedded alongside the
                  raw code.
                </p>
                <p>
                  <strong className="text-text-body">Why it helps:</strong> Raw code embeddings
                  match well for literal searches, but struggle with intent-based queries. The
                  AI-generated description matches far more accurately for questions like{' '}
                  <span className="italic text-text-muted">
                    &quot;how does authentication work?&quot;
                  </span>
                </p>
                <p>
                  <strong className="text-text-body">Tradeoff:</strong> Indexing takes longer and
                  uses Claude Haiku tokens from your subscription. Descriptions are cached —
                  re-indexing only regenerates changed files.
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
                  Index loaded from cache ({persistedIndexStatus.symbolCount?.toLocaleString()}{' '}
                  symbols)
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Database size={12} />
                <span>
                  {embeddingUnavailable
                    ? 'Configure an embedding model in Models to enable semantic search'
                    : 'No cached index — click below to start indexing'}
                </span>
              </div>
            )}
          </div>

          {/* Start / Re-index button */}
          <div className="pl-1">
            <button
              onClick={onStartIndex}
              disabled={isStartingIndex || embeddingUnavailable}
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
  )
}

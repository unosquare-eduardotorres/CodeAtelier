import { useState, useCallback, useRef } from 'react'
import { Search, Loader2, FileCode, AlertCircle } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { SemanticSearchResult } from '../../../../../shared/types'

interface SearchPlaygroundProps {
  workspaceId: string
  indexLoaded: boolean
}

export default function SearchPlayground({
  workspaceId,
  indexLoaded
}: SearchPlaygroundProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SemanticSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queryTimeMs, setQueryTimeMs] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !indexLoaded) return

    setIsSearching(true)
    setError(null)
    setResults([])
    setSearched(true)

    const start = performance.now()
    try {
      const res = await window.api.semanticSearchQuery({
        workspaceId,
        query: query.trim(),
        nResults: 10
      })
      setQueryTimeMs(Math.round(performance.now() - start))
      setResults(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
      setQueryTimeMs(null)
    }
    setIsSearching(false)
  }, [query, workspaceId, indexLoaded])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  /** Score color: green >0.7, yellow >0.5, red <0.5 */
  const getScoreColor = (score: number): string => {
    if (score >= 0.7) return 'bg-success'
    if (score >= 0.5) return 'bg-warning'
    return 'bg-danger'
  }

  const getScoreTextColor = (score: number): string => {
    if (score >= 0.7) return 'text-success'
    if (score >= 0.5) return 'text-warning'
    return 'text-danger'
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-2 mb-3">
        <Search size={14} className="text-text-secondary" />
        <h3 className="text-sm font-medium text-text-body">Search Playground</h3>
      </div>

      {/* Search input */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              indexLoaded ? 'Search your codebase...' : 'Index your codebase first to enable search'
            }
            disabled={!indexLoaded}
            className="w-full px-3 py-2 text-xs bg-surface-base border border-border-default rounded-md text-text-body placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={!indexLoaded || !query.trim() || isSearching}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSearching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          Search
        </button>
      </div>

      {/* Disabled state message */}
      {!indexLoaded && (
        <p className="text-xs text-text-muted mt-2">
          Enable Semantic Search and index your codebase to use the playground.
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="mt-3 flex items-center gap-2 text-xs text-danger">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      )}

      {/* Results metadata */}
      {searched && !isSearching && !error && (
        <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
          <span>
            {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
          {queryTimeMs !== null && <span>· {queryTimeMs}ms</span>}
        </div>
      )}

      {/* Results list */}
      {results.length > 0 && (
        <div className="mt-3 space-y-2 max-h-[400px] overflow-y-auto">
          {results.map((result, i) => (
            <div
              key={`${result.filePath}-${result.symbolName}-${i}`}
              className="rounded-lg bg-surface-base border border-border-subtle p-3 space-y-1.5"
            >
              {/* File path → symbol */}
              <div className="flex items-center gap-1.5 text-xs">
                <FileCode size={12} className="text-text-muted shrink-0" />
                <span className="text-text-secondary truncate">{result.filePath}</span>
                {result.symbolName && (
                  <>
                    <span className="text-text-muted">→</span>
                    <span className="text-primary font-medium truncate">{result.symbolName}</span>
                  </>
                )}
              </div>

              {/* Score bar */}
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-mono ${getScoreTextColor(result.score)}`}>
                  {result.score.toFixed(3)}
                </span>
                <div className="flex-1 h-1 bg-surface-raised rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${getScoreColor(result.score)}`}
                    style={{ width: `${Math.min(result.score * 100, 100)}%` }}
                  />
                </div>
              </div>

              {/* Code preview */}
              {result.body && (
                <pre className="text-[10px] leading-relaxed text-text-muted font-mono bg-surface-raised rounded p-2 overflow-x-auto max-h-[80px]">
                  {result.body.length > 300 ? result.body.slice(0, 300) + '…' : result.body}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {searched && !isSearching && results.length === 0 && !error && (
        <div className="mt-4 text-center py-6">
          <Search size={24} className="text-text-muted mx-auto mb-2 opacity-40" />
          <p className="text-xs text-text-muted">No results found</p>
          <p className="text-xs text-text-muted mt-0.5">Try different keywords or re-index</p>
        </div>
      )}
    </SettingsCard>
  )
}

import { useState } from 'react'
import { Search, Loader2, SearchX } from 'lucide-react'

import FactCard from './FactCard'
import type { MemoryFact } from '../../../../../shared/types'

// ── Helpers ──

/** Map backend matchType to user-friendly display label + style. */
function matchTypeDisplay(raw: string): { label: string; styled: boolean } {
  switch (raw) {
    case 'cosine':
      return { label: 'semantic', styled: true }
    case 'hybrid':
      return { label: 'hybrid', styled: true }
    case 'keyword':
    default:
      return { label: raw, styled: false }
  }
}

// ── Component ──

interface SearchPlaygroundProps {
  workspaceId: string
}

export default function SearchPlayground({
  workspaceId
}: SearchPlaygroundProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<(MemoryFact & { _matchType?: string })[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const handleSearch = async (): Promise<void> => {
    if (!query.trim()) return
    setSearching(true)
    setHasSearched(true)
    try {
      const facts = await window.api.memoryFactsSearch({
        workspaceId,
        query: query.trim()
      })
      setResults(facts)
    } catch {
      // non-fatal
    }
    setSearching(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Search memories with hybrid retrieval..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1 px-3 py-2 bg-input-bg border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-input-focus"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
        >
          {searching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </p>
          {results.map((fact) => (
            <div key={fact.id} className="relative">
              {fact._matchType &&
                (() => {
                  const { label, styled } = matchTypeDisplay(fact._matchType)
                  return (
                    <span
                      className={`absolute top-2 right-2 px-1.5 py-0.5 text-[10px] rounded z-10 ${
                        styled ? 'bg-info-muted text-info' : 'bg-surface-overlay text-text-muted'
                      }`}
                    >
                      {label}
                    </span>
                  )
                })()}
              <FactCard fact={fact} />
            </div>
          ))}
        </div>
      )}

      {/* Empty state after search */}
      {hasSearched && !searching && results.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          <SearchX className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No matches found.</p>
          <p className="text-xs mt-1">
            Try different keywords or embed more memories for semantic search.
          </p>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { Search, Loader2, SearchX } from 'lucide-react'

import { Button } from '@renderer/components/common/ui'
import FactRow from './facts/FactRow'
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

interface MemorySearchPlaygroundProps {
  workspaceId: string
}

/**
 * Named for its domain: `code-intelligence/SearchPlayground` searches the code
 * graph, this one searches memories. Two files exporting `SearchPlayground`
 * made every import site ambiguous at a glance.
 */
export default function MemorySearchPlayground({
  workspaceId
}: MemorySearchPlaygroundProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<(MemoryFact & { _matchType?: string })[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

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
          className="flex-1 h-8 px-3 bg-input-bg border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-input-focus"
        />
        <Button
          variant="primary"
          size="md"
          onClick={handleSearch}
          disabled={searching || !query.trim()}
        >
          {searching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </p>
          {results.map((fact) => (
            <div key={fact.id} className="flex items-start gap-2">
              {fact._matchType &&
                (() => {
                  const { label, styled } = matchTypeDisplay(fact._matchType)
                  return (
                    <span
                      className={`shrink-0 mt-2 px-1.5 py-0.5 text-[11px] rounded ${
                        styled ? 'bg-info-muted text-info' : 'bg-surface-overlay text-text-muted'
                      }`}
                    >
                      {label}
                    </span>
                  )
                })()}
              <div className="flex-1 min-w-0">
                <FactRow
                  fact={fact}
                  expanded={expandedIds.has(fact.id)}
                  onToggleExpand={() =>
                    setExpandedIds((prev) => {
                      const next = new Set(prev)
                      if (next.has(fact.id)) next.delete(fact.id)
                      else next.add(fact.id)
                      return next
                    })
                  }
                />
              </div>
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

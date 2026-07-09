import { useState } from 'react'
import { Search } from 'lucide-react'

import FactCard from './FactCard'
import type { MemoryFact } from '../../../../../shared/types'

// ── Component ──

interface SearchPlaygroundProps {
  workspaceId: string
}

export default function SearchPlayground({ workspaceId }: SearchPlaygroundProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryFact[]>([])
  const [searching, setSearching] = useState(false)

  const handleSearch = async (): Promise<void> => {
    if (!query.trim()) return
    setSearching(true)
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
          placeholder="Search facts with hybrid retrieval..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1 px-3 py-2 bg-input border border-border rounded-md text-sm text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-accent text-accent-foreground rounded-md hover:bg-accent/80 disabled:opacity-50"
        >
          <Search className="w-4 h-4" />
          Search
        </button>
      </div>
      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-tertiary">{results.length} results</p>
          {results.map((fact) => (
            <FactCard key={fact.id} fact={fact} />
          ))}
        </div>
      )}
    </div>
  )
}

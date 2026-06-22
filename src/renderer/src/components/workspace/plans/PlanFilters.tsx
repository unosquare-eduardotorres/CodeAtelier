/**
 * PlanFilters — status tab bar + search input for the Plans Hub.
 */

import { Search } from 'lucide-react'
import {
  usePlanStore,
  usePlanStatusCounts,
  type PlanStatusFilter
} from '@renderer/store/plan.store'

const TABS: { id: PlanStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'saved', label: 'Saved' },
  { id: 'active', label: 'Active' },
  { id: 'done', label: 'Done' }
]

export default function PlanFilters(): React.JSX.Element {
  const { statusFilter, searchQuery, setStatusFilter, setSearchQuery } = usePlanStore()
  const counts = usePlanStatusCounts()

  return (
    <div className="space-y-3">
      {/* Status tabs */}
      <div className="flex items-center gap-1">
        {TABS.map((tab) => {
          const isActive = statusFilter === tab.id
          const count = counts[tab.id]
          return (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`
                inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                transition-colors
                ${
                  isActive
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
                }
              `}
            >
              {tab.label}
              <span
                className={`text-[10px] font-semibold ${isActive ? 'text-primary-text/70' : 'text-text-muted/60'}`}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Search input */}
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search plans..."
          className="w-full pl-9 pr-3 py-2 text-xs bg-surface-base border border-border-subtle
                     rounded-lg text-text-primary placeholder:text-text-muted
                     outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30
                     transition-colors"
        />
      </div>
    </div>
  )
}

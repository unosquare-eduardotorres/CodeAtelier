import { useEffect } from 'react'
import { ArrowLeft, Bug } from 'lucide-react'
import { useBugStore } from '@renderer/store/bug.store'
import BugCard from './BugCard'
import BugDetail from './BugDetail'
import BugFilters from './BugFilters'

interface BugTrackerPageProps {
  onBack: () => void
}

export default function BugTrackerPage({ onBack }: BugTrackerPageProps): React.JSX.Element {
  const bugs = useBugStore((s) => s.bugs)
  const unresolvedCount = useBugStore((s) => s.unresolvedCount)
  const filters = useBugStore((s) => s.filters)
  const isLoading = useBugStore((s) => s.isLoading)
  const selectedBugId = useBugStore((s) => s.selectedBugId)
  const fetchBugs = useBugStore((s) => s.fetchBugs)
  const fetchCount = useBugStore((s) => s.fetchCount)
  const setFilters = useBugStore((s) => s.setFilters)
  const setSelectedBugId = useBugStore((s) => s.setSelectedBugId)
  const resolveBug = useBugStore((s) => s.resolveBug)
  const unresolveBug = useBugStore((s) => s.unresolveBug)
  const deleteBug = useBugStore((s) => s.deleteBug)
  const updateNote = useBugStore((s) => s.updateNote)

  useEffect(() => {
    fetchBugs()
    fetchCount()
  }, [fetchBugs, fetchCount])

  const selectedBug = bugs.find((b) => b.id === selectedBugId) ?? null

  return (
    <div data-testid="bug-tracker-page" className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <Bug size={20} className="text-orange-400" />
        <h1 className="text-lg font-semibold text-text-primary">Bug Tracker</h1>
        {unresolvedCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold bg-red-500 text-white rounded-full">
            {unresolvedCount}
          </span>
        )}
        <div className="ml-auto">
          <BugFilters filters={filters} onFilterChange={setFilters} />
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 min-h-0">
        {/* Bug list */}
        <div data-testid="bug-card" className="w-[380px] flex-shrink-0 border-r border-border-subtle overflow-y-auto p-2 flex flex-col gap-1.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-sm">
              Loading...
            </div>
          ) : bugs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bug size={36} className="text-text-muted mb-3" />
              <p className="text-text-secondary text-sm font-medium">No bugs found</p>
              <p className="text-text-muted text-xs mt-1">
                Uncontrolled errors will appear here automatically
              </p>
            </div>
          ) : (
            bugs.map((bug) => (
              <BugCard
                key={bug.id}
                bug={bug}
                isSelected={selectedBugId === bug.id}
                onClick={() => setSelectedBugId(bug.id)}
              />
            ))
          )}
        </div>

        {/* Detail panel */}
        <div data-testid="bug-detail" className="flex-1 min-w-0">
          {selectedBug ? (
            <BugDetail
              key={selectedBug.id}
              bug={selectedBug}
              onResolve={resolveBug}
              onUnresolve={unresolveBug}
              onDelete={deleteBug}
              onUpdateNote={updateNote}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              Select a bug to view details
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

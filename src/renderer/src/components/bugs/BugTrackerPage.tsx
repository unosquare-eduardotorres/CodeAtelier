import { useEffect, useState, useCallback } from 'react'
import {
  ArrowLeft,
  Bug,
  Copy,
  Check,
  Download,
  CheckSquare,
  Square,
  Minus,
  Search,
  X,
  PartyPopper
} from 'lucide-react'
import { useBugStore } from '@renderer/store/bug.store'
import { useToastStore } from '@renderer/store'
import { copyTextToClipboard } from '@renderer/utils/clipboard'
import { formatBugsAsMarkdown } from './bug-markdown-formatter'
import BugRow from './BugRow'
import BugDetail from './BugDetail'
import BugFilters from './BugFilters'
import BulkActionBar from './BulkActionBar'
import BugSummaryBar from './BugSummaryBar'

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

  const selectedBugIds = useBugStore((s) => s.selectedBugIds)
  const toggleBugSelection = useBugStore((s) => s.toggleBugSelection)
  const selectAllBugs = useBugStore((s) => s.selectAllBugs)
  const deselectAllBugs = useBugStore((s) => s.deselectAllBugs)
  const bulkResolveBugs = useBugStore((s) => s.bulkResolveBugs)
  const bulkDeleteBugs = useBugStore((s) => s.bulkDeleteBugs)

  const searchQuery = useBugStore((s) => s.searchQuery)
  const setSearchQuery = useBugStore((s) => s.setSearchQuery)

  const addToast = useToastStore((s) => s.addToast)

  const [copyIcon, setCopyIcon] = useState<'copy' | 'check'>('copy')

  useEffect(() => {
    fetchBugs()
    fetchCount()
    return () => setSearchQuery('')
  }, [fetchBugs, fetchCount, setSearchQuery])

  // Filter bugs by search query (client-side)
  const filteredBugs = searchQuery.trim()
    ? bugs.filter((b) => b.errorMessage.toLowerCase().includes(searchQuery.toLowerCase()))
    : bugs

  const selectedBug = bugs.find((b) => b.id === selectedBugId) ?? null

  // Context-aware: operate on selected when selection exists, all filtered when none
  const targetBugs =
    selectedBugIds.size > 0 ? filteredBugs.filter((b) => selectedBugIds.has(b.id)) : filteredBugs

  const handleCopyErrors = async (): Promise<void> => {
    const markdown = formatBugsAsMarkdown(targetBugs)
    const ok = await copyTextToClipboard(markdown)
    if (ok) {
      addToast({ type: 'success', message: `Copied ${targetBugs.length} bug(s) to clipboard` })
      setCopyIcon('check')
      setTimeout(() => setCopyIcon('copy'), 2000)
    }
  }

  const handleExport = async (): Promise<void> => {
    const markdown = formatBugsAsMarkdown(targetBugs)
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const defaultFilename = `bugs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`
    await window.api.bugExportMarkdown({ markdown, defaultFilename })
  }

  // Select-all checkbox state (based on filteredBugs)
  const allSelected = filteredBugs.length > 0 && filteredBugs.every((b) => selectedBugIds.has(b.id))
  const someSelected = selectedBugIds.size > 0 && !allSelected

  const selectFilteredBugs = useCallback(
    () => selectAllBugs(filteredBugs.map((b) => b.id)),
    [selectAllBugs, filteredBugs]
  )

  const handleSelectAllToggle = (): void => {
    if (allSelected) {
      deselectAllBugs()
    } else {
      selectFilteredBugs()
    }
  }

  // Keyboard shortcuts: Ctrl/Cmd+A = select all, Escape = deselect all
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        selectFilteredBugs()
      } else if (e.key === 'Escape') {
        deselectAllBugs()
      }
    },
    [selectFilteredBugs, deselectAllBugs]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Context-aware button labels
  const copyLabel =
    selectedBugIds.size > 0
      ? `Copy ${selectedBugIds.size} selected`
      : `Copy all ${filteredBugs.length}`
  const exportLabel =
    selectedBugIds.size > 0
      ? `Export ${selectedBugIds.size} selected`
      : `Export all ${filteredBugs.length}`

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

        {/* Selection indicator with clear button */}
        {selectedBugIds.size > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary-muted/20 border border-primary-muted/40">
            <CheckSquare size={12} className="text-primary-text" />
            <span className="text-xs font-medium text-primary-text">
              {selectedBugIds.size} selected
            </span>
            <button
              onClick={deselectAllBugs}
              className="p-0.5 rounded hover:bg-primary-muted/30 text-primary-text transition-colors"
              aria-label="Clear selection"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Search input */}
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search errors..."
              className="pl-7 pr-3 py-1.5 text-xs rounded-lg border border-border-subtle bg-surface-base text-text-body placeholder:text-text-muted/60 focus:outline-none focus:ring-1 focus:ring-primary-muted w-[160px]"
            />
          </div>

          <BugFilters filters={filters} onFilterChange={setFilters} />

          {/* Copy Errors button */}
          <button
            onClick={handleCopyErrors}
            disabled={filteredBugs.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-surface-overlay border border-border-subtle text-text-secondary hover:bg-surface-base hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={copyLabel}
          >
            {copyIcon === 'check' ? <Check size={14} /> : <Copy size={14} />}
            <span className="hidden xl:inline">{copyLabel}</span>
            <span className="xl:hidden">Copy</span>
          </button>

          {/* Export MD button */}
          <button
            onClick={handleExport}
            disabled={filteredBugs.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-surface-overlay border border-border-subtle text-text-secondary hover:bg-surface-base hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={exportLabel}
          >
            <Download size={14} />
            <span className="hidden xl:inline">{exportLabel}</span>
            <span className="xl:hidden">Export</span>
          </button>
        </div>
      </div>

      {/* Summary bar — only when bugs exist */}
      {bugs.length > 0 && (
        <div className="px-4 pt-3">
          <BugSummaryBar bugs={bugs} />
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 min-h-0">
        {/* Bug list */}
        <div
          data-testid="bug-card"
          className="w-[420px] flex-shrink-0 border-r border-border-subtle overflow-y-auto flex flex-col"
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-sm">
              Loading...
            </div>
          ) : filteredBugs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 rounded-2xl bg-success/15 flex items-center justify-center mb-4">
                <PartyPopper size={28} className="text-success" />
              </div>
              <p className="text-text-primary text-sm font-semibold">No bugs detected</p>
              <p className="text-text-muted text-xs mt-1.5 max-w-[240px]">
                {searchQuery.trim()
                  ? 'No bugs match your search. Try a different query.'
                  : 'Your app is running clean. Errors will appear here automatically when they occur.'}
              </p>
            </div>
          ) : (
            <>
              {/* Select-all bar (compact) */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-default bg-surface-overlay/50 sticky top-0 z-10">
                <button
                  onClick={handleSelectAllToggle}
                  className="flex-shrink-0 p-0.5 rounded hover:bg-surface-base transition-colors"
                  aria-label={allSelected ? 'Deselect all' : 'Select all'}
                >
                  {allSelected ? (
                    <CheckSquare size={14} className="text-primary" />
                  ) : someSelected ? (
                    <Minus size={14} className="text-primary" />
                  ) : (
                    <Square size={14} className="text-text-muted" />
                  )}
                </button>
                <span className="text-[11px] text-text-muted">
                  {allSelected ? 'Deselect all' : `Select all (${filteredBugs.length})`}
                </span>
              </div>

              {/* Bug rows — using filteredBugs */}
              {filteredBugs.map((bug) => (
                <BugRow
                  key={bug.id}
                  bug={bug}
                  isSelected={selectedBugIds.has(bug.id)}
                  isViewing={selectedBugId === bug.id}
                  onToggleSelect={toggleBugSelection}
                  onClick={() => setSelectedBugId(bug.id)}
                />
              ))}
            </>
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

      {/* Bulk action bar */}
      {selectedBugIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedBugIds.size}
          onResolveAll={() => bulkResolveBugs([...selectedBugIds])}
          onDeleteAll={() => bulkDeleteBugs([...selectedBugIds])}
          onExport={handleExport}
          onCopyErrors={handleCopyErrors}
          onClearSelection={deselectAllBugs}
        />
      )}
    </div>
  )
}

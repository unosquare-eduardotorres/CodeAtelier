import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Database,
  Search,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Zap,
  CircleDot,
  RefreshCw,
  Copy,
  ArrowUpDown,
  ChevronLeft
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import {
  MemoryExplainer,
  FactCard,
  ContradictionCard,
  SearchPlayground,
  CaptureSettings,
  IngestDocuments,
  GraphView,
  BootstrapKnowledge,
  ClaudeMdPanel
} from './memory'
import type {
  MemoryEmbeddingStatus,
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier
} from '../../../../shared/types'

// ── Constants ──

const ALL_CATEGORIES: MemoryFactCategory[] = ['decision', 'convention', 'gotcha', 'preference', 'reference']
const ALL_TIERS = [0, 1, 2, 3] as const
const TIER_LABELS: Record<number, string> = { 0: 'T0 Observed', 1: 'T1 Confirmed', 2: 'T2 Established', 3: 'T3 Wisdom' }
const TIER_COLORS: Record<number, string> = { 0: 'text-text-muted', 1: 'text-info', 2: 'text-success', 3: 'text-primary-text' }
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'tier', label: 'Tier' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'confirms', label: 'Confirms' }
] as const
type SortMode = (typeof SORT_OPTIONS)[number]['value']
const BATCH_SIZE = 60

const TABS = ['graph', 'settings', 'facts', 'contradictions', 'claudemd'] as const
type TabKey = (typeof TABS)[number]

const TAB_LABELS: Record<TabKey, string> = {
  graph: 'Brain',
  settings: 'Ingestion',
  facts: 'Memories',
  contradictions: 'Review',
  claudemd: 'CLAUDE.md'
}

// ── Main Page (thin tab-shell) ──

export default function MemorySettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    facts,
    contradictions,
    contradictionsPage,
    contradictionsTotal,
    contradictionsPendingCount,
    searchQuery,
    embeddingStatus,
    captureSettings,
    backfillProgress,
    backfillError,
    feedStatus,
    feedMessage,
    feedError,
    loadFacts,
    searchFacts,
    archiveFact,
    confirmFact,
    deleteFact,
    toggleScope,
    loadContradictions,
    resolveContradiction,
    autoResolveDuplicates,
    loadEmbeddingStatus,
    loadCaptureSettings,
    updateCaptureSettings,
    triggerBackfill,
    clearBackfillError,
    scanForDuplicates,
    startFeed,
    dismissFeed,
    setSearchQuery
  } = useMemoryStore()

  const [dedupScanning, setDedupScanning] = useState(false)
  const [dedupResult, setDedupResult] = useState<string | null>(null)
  const [autoResolving, setAutoResolving] = useState(false)
  const [autoResolveResult, setAutoResolveResult] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<TabKey>('facts')
  const [showSearchPlayground, setShowSearchPlayground] = useState(false)

  // ── Toolbar state ──
  const [filterCategories, setFilterCategories] = useState<Set<MemoryFactCategory>>(new Set(ALL_CATEGORIES))
  const [filterTiers, setFilterTiers] = useState<Set<number>>(new Set([0, 1, 2, 3]))
  const [filterStatus, setFilterStatus] = useState<'all' | 'validated' | 'unvalidated' | 'pending-embedding'>('all')
  const [sortMode, setSortMode] = useState<SortMode>('tier')
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)

  const workspaceId = activeWorkspace?.id ?? null

  // Load data on mount
  useEffect(() => {
    if (workspaceId) {
      loadFacts(workspaceId)
      loadContradictions()
      loadEmbeddingStatus(workspaceId)
      loadCaptureSettings(workspaceId)
    }
  }, [workspaceId])

  // Auto-refresh embedding status when model comes online
  useEffect(() => {
    if (!workspaceId) return
    const unsubscribe = window.api.onEmbeddingModelReady(() => {
      loadEmbeddingStatus(workspaceId)
    })
    return unsubscribe
  }, [workspaceId])

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
  }, [filterCategories, filterTiers, filterStatus, sortMode, searchQuery])

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query)
      if (workspaceId) {
        if (query.trim()) {
          searchFacts(workspaceId, query)
        } else {
          loadFacts(workspaceId)
        }
      }
    },
    [workspaceId]
  )

  const handleFeedDocument = useCallback(async () => {
    if (!activeWorkspace) return
    const filePath = await window.api.memorySelectDocument()
    if (!filePath) return
    startFeed('document')
    await window.api.memoryFeedDocument({
      workspacePath: activeWorkspace.repoPath,
      filePath
    })
    if (workspaceId) loadFacts(workspaceId)
  }, [activeWorkspace, workspaceId])

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        Select a workspace to manage memories
      </div>
    )
  }

  const activeFacts = facts.filter((f) => f.status === 'active')
  const supersededFacts = facts.filter((f) => f.status === 'superseded')

  return (
    <div data-testid="memory-settings-page" className="space-y-6">
      {/* ── Embedding Status Strip ── */}
      <EmbeddingStatusStrip
        status={embeddingStatus}
        backfillProgress={backfillProgress}
        backfillError={backfillError}
        onBackfill={() => triggerBackfill(workspaceId)}
        onDismissError={clearBackfillError}
      />

      {/* ── Tab Navigation ── */}
      <div className="flex gap-2 border-b border-border-default pb-2">
        {TABS.map((tab) => (
          <button
            key={tab}
            data-testid={`memory-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === tab
                ? 'bg-primary-muted text-primary-text border border-border-default'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
            }`}
          >
            {tab === 'facts' && `${TAB_LABELS[tab]} (${activeFacts.length})`}
            {tab === 'contradictions' &&
              `${TAB_LABELS[tab]}${contradictionsPendingCount > 0 ? ` (${contradictionsPendingCount})` : ''}`}
            {tab !== 'facts' && tab !== 'contradictions' && TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* ── Brain Tab (Graph) ── */}
      {activeTab === 'graph' && (
        <GraphView workspaceId={workspaceId} />
      )}

      {/* ── Ingestion Tab (was Capture/Settings) ── */}
      {activeTab === 'settings' && (
        <div className="space-y-6">
          <BootstrapKnowledge />

          <div className="border-t border-border-default" />

          <IngestDocuments />

          <div className="border-t border-border-default" />

          <CaptureSettings
            captureSettings={captureSettings}
            feedStatus={feedStatus}
            feedMessage={feedMessage}
            feedError={feedError}
            onFeedDocument={handleFeedDocument}
            onUpdateSettings={updateCaptureSettings}
            workspaceId={workspaceId}
          />
        </div>
      )}

      {/* ── Memories Tab (Facts + folded-in Search) ── */}
      {activeTab === 'facts' && (
        <div className="space-y-3">
          <FactsTab
            activeFacts={activeFacts}
            supersededFacts={supersededFacts}
            searchQuery={searchQuery}
            filterCategories={filterCategories}
            filterTiers={filterTiers}
            filterStatus={filterStatus}
            sortMode={sortMode}
            visibleCount={visibleCount}
            onSearch={handleSearch}
            onSetFilterCategories={setFilterCategories}
            onSetFilterTiers={setFilterTiers}
            onSetFilterStatus={setFilterStatus}
            onSetSortMode={setSortMode}
            onSetVisibleCount={setVisibleCount}
            onConfirm={(id) => confirmFact(id, workspaceId)}
            onArchive={(id) => archiveFact(id, workspaceId)}
            onDelete={(id) => deleteFact(id)}
            onScopeToggle={(fact) =>
              toggleScope(fact.id, !!fact.workspaceId, fact.workspaceId ? undefined : workspaceId)
            }
          />

          {/* Collapsible Search Playground */}
          <div className="border-t border-border-default pt-3">
            <button
              onClick={() => setShowSearchPlayground(!showSearchPlayground)}
              className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {showSearchPlayground ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <Search className="w-3.5 h-3.5" />
              Advanced search / match insights
            </button>
            {showSearchPlayground && (
              <div className="mt-3">
                <SearchPlayground workspaceId={workspaceId} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Review Tab (Contradictions — paginated + actionable) ── */}
      {activeTab === 'contradictions' && (
        <div className="space-y-3">
          {/* Action bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={async () => {
                setDedupScanning(true)
                setDedupResult(null)
                const result = await scanForDuplicates(workspaceId)
                setDedupResult(
                  (result.clustersFound > 0 || result.autoMerged > 0)
                    ? `Found ${result.clustersFound} cluster${result.clustersFound !== 1 ? 's' : ''}, auto-merged ${result.autoMerged}`
                    : 'No duplicates found'
                )
                setDedupScanning(false)
              }}
              disabled={dedupScanning || (embeddingStatus?.pendingCount ?? 0) > 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
              title={
                (embeddingStatus?.pendingCount ?? 0) > 0
                  ? 'Embed memories first'
                  : 'Scan embedded memories for near-duplicates'
              }
            >
              <Copy className="w-4 h-4" />
              {dedupScanning ? 'Scanning…' : 'Scan for duplicates'}
            </button>

            {/* Auto-resolve button */}
            {contradictionsTotal > 0 && (
              <button
                onClick={async () => {
                  setAutoResolving(true)
                  setAutoResolveResult(null)
                  const result = await autoResolveDuplicates(workspaceId, 0.95)
                  setAutoResolveResult(
                    result.resolvedCount > 0
                      ? `Auto-resolved ${result.resolvedCount} near-exact duplicate${result.resolvedCount !== 1 ? 's' : ''}`
                      : 'No near-exact duplicates to resolve'
                  )
                  setAutoResolving(false)
                }}
                disabled={autoResolving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-success-muted text-success border border-success/30 rounded-md hover:bg-success/20 disabled:opacity-50"
              >
                <Zap className="w-4 h-4" />
                {autoResolving ? 'Resolving…' : 'Auto-resolve near-exact duplicates (≥0.95)'}
              </button>
            )}

            {/* Results */}
            {dedupResult && <span className="text-xs text-text-muted">{dedupResult}</span>}
            {autoResolveResult && <span className="text-xs text-success">{autoResolveResult}</span>}
          </div>

          {/* Summary header */}
          {contradictionsTotal > 0 && (
            <div className="text-xs text-text-muted">
              Showing {contradictions.length === 0 ? 0 : contradictionsPage * 25 + 1}–
              {Math.min((contradictionsPage + 1) * 25, contradictionsTotal)} of {contradictionsTotal}
            </div>
          )}

          {/* Cards */}
          {contradictions.length === 0 ? (
            <div className="text-center py-12 text-text-muted">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No contradictions to review.</p>
            </div>
          ) : (
            contradictions.map((c) => (
              <ContradictionCard
                key={c.id}
                contradiction={c}
                allFacts={facts}
                onResolve={resolveContradiction}
              />
            ))
          )}

          {/* Pagination */}
          {contradictionsTotal > 25 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => loadContradictions(undefined, contradictionsPage - 1)}
                disabled={contradictionsPage === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-surface-overlay border border-border-default rounded hover:bg-surface-float disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-3 h-3" /> Previous
              </button>
              <span className="text-xs text-text-muted">
                Page {contradictionsPage + 1} of {Math.ceil(contradictionsTotal / 25)}
              </span>
              <button
                onClick={() => loadContradictions(undefined, contradictionsPage + 1)}
                disabled={(contradictionsPage + 1) * 25 >= contradictionsTotal}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-surface-overlay border border-border-default rounded hover:bg-surface-float disabled:opacity-30 transition-colors"
              >
                Next <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── CLAUDE.md Tab ── */}
      {activeTab === 'claudemd' && (
        <ClaudeMdPanel />
      )}
    </div>
  )
}

// ── Facts Tab (extracted for clarity) ──

interface FactsTabProps {
  activeFacts: MemoryFact[]
  supersededFacts: MemoryFact[]
  searchQuery: string
  filterCategories: Set<MemoryFactCategory>
  filterTiers: Set<number>
  filterStatus: 'all' | 'validated' | 'unvalidated' | 'pending-embedding'
  sortMode: SortMode
  visibleCount: number
  onSearch: (q: string) => void
  onSetFilterCategories: (fn: (prev: Set<MemoryFactCategory>) => Set<MemoryFactCategory>) => void
  onSetFilterTiers: (fn: (prev: Set<number>) => Set<number>) => void
  onSetFilterStatus: (s: 'all' | 'validated' | 'unvalidated' | 'pending-embedding') => void
  onSetSortMode: (s: SortMode) => void
  onSetVisibleCount: (n: number) => void
  onConfirm: (id: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onScopeToggle: (fact: MemoryFact) => void
}

function FactsTab({
  activeFacts,
  supersededFacts,
  searchQuery,
  filterCategories,
  filterTiers,
  filterStatus,
  sortMode,
  visibleCount,
  onSearch,
  onSetFilterCategories,
  onSetFilterTiers,
  onSetFilterStatus,
  onSetSortMode,
  onSetVisibleCount,
  onConfirm,
  onArchive,
  onDelete,
  onScopeToggle
}: FactsTabProps): React.JSX.Element {
  // ── Stats ──
  const tierCounts = useMemo(() => {
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
    for (const f of activeFacts) {
      const t = Math.min(f.tier, 3)
      counts[t] = (counts[t] ?? 0) + 1
    }
    return counts
  }, [activeFacts])

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const f of activeFacts) counts[f.category] = (counts[f.category] ?? 0) + 1
    return counts
  }, [activeFacts])

  const validatedCount = useMemo(
    () => activeFacts.filter((f) => f.tier >= 1 || (f.evidenceCount ?? 0) > 0).length,
    [activeFacts]
  )
  const validatedPct = activeFacts.length > 0 ? Math.round((validatedCount / activeFacts.length) * 100) : 0

  // ── Filter + Sort ──
  const filteredAndSorted = useMemo(() => {
    let items = activeFacts.filter((f) => {
      if (!filterCategories.has(f.category)) return false
      if (!filterTiers.has(Math.min(f.tier, 3))) return false
      if (filterStatus === 'validated' && f.tier < 1 && (f.evidenceCount ?? 0) === 0) return false
      if (filterStatus === 'unvalidated' && (f.tier >= 1 || (f.evidenceCount ?? 0) > 0)) return false
      if (filterStatus === 'pending-embedding' && !f.embeddingPending) return false
      return true
    })

    // Sort
    items = [...items]
    switch (sortMode) {
      case 'newest':
        items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
      case 'tier':
        items.sort((a, b) => b.tier - a.tier || b.confidence - a.confidence)
        break
      case 'confidence':
        items.sort((a, b) => b.confidence - a.confidence)
        break
      case 'confirms':
        items.sort((a, b) => b.confirmationCount - a.confirmationCount)
        break
    }

    return items
  }, [activeFacts, filterCategories, filterTiers, filterStatus, sortMode])

  // ── Grouped by tier (when sort mode = 'tier') ──
  const groupedByTier = useMemo(() => {
    if (sortMode !== 'tier') return null
    const groups: Record<number, MemoryFact[]> = { 3: [], 2: [], 1: [], 0: [] }
    for (const f of filteredAndSorted) {
      const t = Math.min(f.tier, 3)
      groups[t].push(f)
    }
    return groups
  }, [filteredAndSorted, sortMode])

  // ── Render helpers ──
  const renderFactCard = useCallback(
    (fact: MemoryFact) => (
      <FactCard
        key={fact.id}
        fact={fact}
        onConfirm={() => onConfirm(fact.id)}
        onArchive={() => onArchive(fact.id)}
        onDelete={() => onDelete(fact.id)}
        onScopeToggle={() => onScopeToggle(fact)}
      />
    ),
    [onConfirm, onArchive, onDelete, onScopeToggle]
  )

  const remaining = filteredAndSorted.length - visibleCount

  return (
    <div className="space-y-3">
      {/* Explainer panel */}
      <MemoryExplainer />

      {/* ── Stats Strip ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {ALL_TIERS.map((t) => (
          <button
            key={t}
            onClick={() =>
              onSetFilterTiers((prev) => {
                const next = new Set(prev)
                // If clicking the only active tier, reset to all
                if (next.size === 1 && next.has(t)) {
                  return new Set([0, 1, 2, 3])
                }
                // Solo this tier
                return new Set([t])
              })
            }
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors cursor-pointer ${
              filterTiers.has(t)
                ? 'border-border-default bg-surface-overlay'
                : 'border-transparent bg-surface-overlay/40 opacity-50'
            }`}
          >
            <span className={`font-mono font-medium ${TIER_COLORS[t]}`}>{TIER_LABELS[t]}</span>
            <span className="text-text-muted">{tierCounts[t]}</span>
          </button>
        ))}
        <span className="text-xs text-text-muted ml-1">
          {validatedPct}% validated
        </span>
      </div>

      {/* ── Toolbar Row ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Category chips */}
        {ALL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() =>
              onSetFilterCategories((prev) => {
                const next = new Set(prev)
                next.has(cat) ? next.delete(cat) : next.add(cat)
                // Don't allow empty set
                if (next.size === 0) return new Set(ALL_CATEGORIES)
                return next
              })
            }
            className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors ${
              filterCategories.has(cat)
                ? 'border-border-default bg-surface-overlay text-text-secondary'
                : 'border-transparent text-text-muted opacity-50'
            }`}
          >
            {cat}
            <span className="text-text-muted">{categoryCounts[cat] ?? 0}</span>
          </button>
        ))}

        <div className="flex-1" />

        {/* Status select */}
        <select
          value={filterStatus}
          onChange={(e) => onSetFilterStatus(e.target.value as typeof filterStatus)}
          className="px-2 py-1 text-xs bg-input-bg border border-border-default rounded text-text-secondary focus:outline-none focus:ring-1 focus:ring-input-focus"
        >
          <option value="all">All</option>
          <option value="validated">Validated</option>
          <option value="unvalidated">Unvalidated</option>
          <option value="pending-embedding">Pending embed</option>
        </select>

        {/* Sort select */}
        <div className="flex items-center gap-1">
          <ArrowUpDown className="w-3 h-3 text-text-muted" />
          <select
            value={sortMode}
            onChange={(e) => onSetSortMode(e.target.value as SortMode)}
            className="px-2 py-1 text-xs bg-input-bg border border-border-default rounded text-text-secondary focus:outline-none focus:ring-1 focus:ring-input-focus"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-2.5 w-4 h-4 text-text-muted" />
        <input
          type="text"
          placeholder="Filter memories..."
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 bg-input-bg border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-input-focus"
        />
      </div>

      {/* Fact cards — grouped by tier or flat */}
      {filteredAndSorted.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <Database className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No memories match the current filters.</p>
          <p className="text-xs mt-1">
            Memories are automatically extracted from sessions, commits, and documents.
          </p>
        </div>
      ) : groupedByTier ? (
        // ── Tier-grouped view ──
        <>
          {([3, 2, 1, 0] as const).map((t) => {
            const tierFacts = groupedByTier[t]
            if (tierFacts.length === 0) return null
            return (
              <TierGroup
                key={t}
                tier={t as MemoryFactTier}
                facts={tierFacts}
                defaultOpen={t >= 2}
                renderCard={renderFactCard}
              />
            )
          })}
        </>
      ) : (
        // ── Flat view with incremental rendering ──
        <>
          {filteredAndSorted.slice(0, visibleCount).map(renderFactCard)}
          {remaining > 0 && (
            <button
              onClick={() => onSetVisibleCount(visibleCount + BATCH_SIZE)}
              className="w-full py-2 text-sm text-text-secondary hover:text-text-primary bg-surface-overlay hover:bg-surface-float rounded-md transition-colors"
            >
              Show more ({remaining} remaining)
            </button>
          )}
        </>
      )}

      {/* Superseded section */}
      {supersededFacts.length > 0 && (
        <CollapsibleSection title={`Superseded (${supersededFacts.length})`}>
          {supersededFacts.map((fact) => (
            <FactCard key={fact.id} fact={fact} onDelete={() => onDelete(fact.id)} dimmed />
          ))}
        </CollapsibleSection>
      )}
    </div>
  )
}

// ── Tier Group (collapsible) ──

function TierGroup({
  tier,
  facts,
  defaultOpen,
  renderCard
}: {
  tier: MemoryFactTier
  facts: MemoryFact[]
  defaultOpen: boolean
  renderCard: (f: MemoryFact) => React.JSX.Element
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)

  const remaining = facts.length - visibleCount

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary w-full"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className={`font-mono font-medium ${TIER_COLORS[tier]}`}>{TIER_LABELS[tier]}</span>
        <span className="text-text-muted text-xs">({facts.length})</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {facts.slice(0, visibleCount).map(renderCard)}
          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount((v) => v + BATCH_SIZE)}
              className="w-full py-1.5 text-xs text-text-secondary hover:text-text-primary bg-surface-overlay hover:bg-surface-float rounded transition-colors"
            >
              Show more ({remaining} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Retained sub-components (local to page) ──

function EmbeddingStatusStrip({
  status,
  backfillProgress,
  backfillError,
  onBackfill,
  onDismissError
}: {
  status: MemoryEmbeddingStatus | null
  backfillProgress: { running: boolean; processed: number; total: number } | null
  backfillError: string | null
  onBackfill: () => void
  onDismissError: () => void
}): React.JSX.Element | null {
  if (!status) return null

  const isRunning = backfillProgress?.running === true
  const embeddedCount = status.totalCount - status.pendingCount

  // Error state — show the actual error message with retry
  if (backfillError) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-danger/10 border border-danger/30 rounded-md text-sm">
        <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
        <span className="flex-1 text-danger text-xs">
          {backfillError}
        </span>
        <button
          onClick={() => { onDismissError(); onBackfill() }}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-primary-muted text-primary-text border border-border-default rounded hover:bg-primary/20"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    )
  }

  // Offline state
  if (!status.isReady && !isRunning) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-overlay border border-border-default rounded-md text-sm">
        <CircleDot className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="flex-1 text-text-secondary">
          Embedding model offline (oMLX)
        </span>
        <button
          onClick={onBackfill}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-primary-muted text-primary-text border border-border-default rounded hover:bg-primary/20"
        >
          <RefreshCw className="w-3 h-3" /> Retry & Embed
        </button>
      </div>
    )
  }

  // Running state
  if (isRunning && backfillProgress) {
    const pct = backfillProgress.total > 0
      ? Math.round((backfillProgress.processed / backfillProgress.total) * 100)
      : 0
    return (
      <div className="px-4 py-2.5 bg-surface-overlay border border-border-default rounded-md text-sm space-y-1.5">
        <div className="flex items-center gap-3">
          <CircleDot className="w-3.5 h-3.5 text-info shrink-0 animate-pulse" />
          <span className="flex-1 text-text-secondary">
            Embedding… {backfillProgress.processed} / {backfillProgress.total}
          </span>
          <span className="text-xs text-text-muted">{pct}%</span>
        </div>
        <div className="w-full h-1 bg-border-default rounded-full overflow-hidden">
          <div
            className="h-full bg-info rounded-full transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }

  // Ready with pending
  if (status.pendingCount > 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-overlay border border-border-default rounded-md text-sm">
        <CircleDot className="w-3.5 h-3.5 text-success shrink-0" />
        <span className="flex-1 text-text-secondary">
          {status.modelName ?? 'Embedding'} · {embeddedCount} of {status.totalCount} embedded
        </span>
        <button
          onClick={onBackfill}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-primary-muted text-primary-text border border-border-default rounded hover:bg-primary/20"
        >
          <Zap className="w-3 h-3" /> Embed Now
        </button>
      </div>
    )
  }

  // Fully embedded — subtle line
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-surface-overlay/50 border border-border-default/50 rounded-md text-xs text-text-muted">
      <CircleDot className="w-3 h-3 text-success shrink-0" />
      <span>{status.modelName ?? 'Embedding'} · {embeddedCount} of {status.totalCount} embedded</span>
    </div>
  )
}

function CollapsibleSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {title}
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  )
}

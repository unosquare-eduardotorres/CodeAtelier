import { useCallback, useEffect, useState } from 'react'
import { Brain } from 'lucide-react'

import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import { ErrorBoundary } from '@renderer/components/common/ErrorBoundary'
import { Button, Tabs, type TabItem } from '@renderer/components/common/ui'
import { GraphView, ClaudeMdPanel, FactsTab, ReviewTab, IngestionTab } from './memory'
import { EmbeddingBar, EmbeddingChip } from './memory/EmbeddingStatus'

// ── Constants ──

const TABS = ['graph', 'settings', 'facts', 'contradictions', 'claudemd'] as const
type TabKey = (typeof TABS)[number]

const TAB_LABELS: Record<TabKey, string> = {
  graph: 'Brain',
  settings: 'Ingestion',
  facts: 'Memories',
  contradictions: 'Review',
  claudemd: 'CLAUDE.md'
}

const TAB_STORAGE_KEY = 'memory-page-tab'

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TABS as readonly string[]).includes(value)
}

/** 2721 → "2.7k" — a five-digit badge crowds the tab rail. */
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ── Page shell ──

export default function MemorySettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    facts,
    contradictionsPendingCount,
    embeddingStatus,
    backfillProgress,
    backfillError,
    loadFacts,
    loadContradictions,
    loadEmbeddingStatus,
    loadCaptureSettings,
    triggerBackfill,
    clearBackfillError,
    startFeed
  } = useMemoryStore()

  // Persisted so a remount does not always drop you on the heaviest tab.
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const stored = localStorage.getItem(TAB_STORAGE_KEY)
    return isTabKey(stored) ? stored : 'facts'
  })

  const workspaceId = activeWorkspace?.id ?? null

  useEffect(() => {
    localStorage.setItem(TAB_STORAGE_KEY, activeTab)
  }, [activeTab])

  // Load data on mount
  useEffect(() => {
    if (workspaceId) {
      loadFacts(workspaceId)
      loadContradictions()
      loadEmbeddingStatus(workspaceId)
      loadCaptureSettings(workspaceId)
    }
  }, [workspaceId])

  // Auto-refresh embedding status when the model comes online
  useEffect(() => {
    if (!workspaceId) return
    return window.api.onEmbeddingModelReady(() => loadEmbeddingStatus(workspaceId))
  }, [workspaceId])

  const handleFeedDocument = useCallback(async () => {
    if (!activeWorkspace) return
    const filePath = await window.api.memorySelectDocument()
    if (!filePath) return
    startFeed('document')
    try {
      await window.api.memoryFeedDocument({
        workspacePath: activeWorkspace.repoPath,
        filePath
      })
    } catch {
      // The failure is already reported through the feed progress channel,
      // which is what drives the panel; swallow the rejection so it does not
      // surface as an unhandled promise.
    }
    if (workspaceId) loadFacts(workspaceId)
  }, [activeWorkspace, workspaceId])

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        Select a workspace to manage memories
      </div>
    )
  }

  // The DB count of *active* facts, not the loaded page — the old badge
  // drifted as soon as a semantic search replaced the list, and using the
  // all-status total made it permanently disagree with the list, which shows
  // active facts only.
  const totalMemories =
    embeddingStatus?.activeCount ?? facts.filter((f) => f.status === 'active').length

  const tabItems: TabItem<TabKey>[] = TABS.map((tab) => ({
    key: tab,
    label: TAB_LABELS[tab],
    testId: `memory-tab-${tab}`,
    badge:
      tab === 'facts'
        ? compact(totalMemories)
        : tab === 'contradictions' && contradictionsPendingCount > 0
          ? contradictionsPendingCount
          : undefined
  }))

  return (
    <div
      data-testid="memory-settings-page"
      className="flex flex-col h-full min-h-0 px-6 pt-4 max-w-[1400px] w-full mx-auto"
    >
      {/* ── Header ── */}
      <header className="flex items-center gap-3 pb-3 shrink-0">
        <Brain className="w-5 h-5 text-teal shrink-0" />
        <div className="min-w-0">
          <h2 className="text-base font-medium text-text-primary leading-tight">Brain</h2>
          <p className="text-[11px] text-text-muted truncate">{activeWorkspace?.name}</p>
        </div>
        <div className="flex-1" />
        <EmbeddingChip
          status={embeddingStatus}
          backfillProgress={backfillProgress}
          backfillError={backfillError}
        />
        <Button variant="primary" size="md" onClick={() => setActiveTab('settings')}>
          Feed Brain
        </Button>
      </header>

      {/* Renders nothing at all when there is no embedding work outstanding */}
      <EmbeddingBar
        status={embeddingStatus}
        backfillProgress={backfillProgress}
        backfillError={backfillError}
        onBackfill={() => triggerBackfill(workspaceId)}
        onDismissError={clearBackfillError}
      />

      {/* ── Tab rail ── */}
      <div className="border-b border-border-default shrink-0">
        <Tabs
          items={tabItems}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="Memory views"
          idPrefix="memory-tab"
        />
      </div>

      {/* ── Tab body — owns its own scroll so toolbars stay put ── */}
      <div
        role="tabpanel"
        id={`memory-tabpanel-${activeTab}`}
        aria-labelledby={`memory-tab-${activeTab}`}
        className="flex-1 min-h-0 flex flex-col pt-3 pb-4"
      >
        {activeTab === 'graph' && (
          <ErrorBoundary
            fallback={
              <div className="flex items-center justify-center h-64 text-text-muted text-sm">
                Graph visualization encountered an error. Switch tabs and back to retry.
              </div>
            }
          >
            <div className="flex-1 min-h-0 overflow-auto">
              <GraphView workspaceId={workspaceId} />
            </div>
          </ErrorBoundary>
        )}

        {activeTab === 'settings' && (
          <IngestionTab
            workspaceId={workspaceId}
            workspacePath={activeWorkspace?.repoPath ?? ''}
            onFeedDocument={handleFeedDocument}
          />
        )}

        {activeTab === 'facts' && <FactsTab workspaceId={workspaceId} />}

        {activeTab === 'contradictions' && <ReviewTab workspaceId={workspaceId} />}

        {activeTab === 'claudemd' && <ClaudeMdPanel />}
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  Search,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Zap
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import {
  MemoryExplainer,
  FactCard,
  ContradictionCard,
  SearchPlayground,
  CaptureSettings
} from './memory'
import type { MemoryEmbeddingStatus } from '../../../../shared/types'

// ── Main Page (thin tab-shell) ──

export default function MemorySettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    facts,
    contradictions,
    searchQuery,
    embeddingStatus,
    captureSettings,
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
    loadEmbeddingStatus,
    loadCaptureSettings,
    updateCaptureSettings,
    triggerBackfill,
    startFeed,
    dismissFeed,
    setSearchQuery
  } = useMemoryStore()

  const [activeTab, setActiveTab] = useState<'facts' | 'contradictions' | 'search' | 'settings'>(
    'facts'
  )
  const [showDiffModal, setShowDiffModal] = useState(false)
  const [diffData, setDiffData] = useState<{
    existing: string | null
    generated: string
  } | null>(null)

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

  const handleRegenerateClaudeMd = useCallback(async () => {
    if (!activeWorkspace) return
    startFeed('document')
    const result = await window.api.memoryRegenerateClaudeMd({
      workspacePath: activeWorkspace.repoPath
    })
    if (result.success && result.content) {
      setDiffData({ existing: result.existing ?? null, generated: result.content })
      setShowDiffModal(true)
    }
    dismissFeed()
  }, [activeWorkspace])

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-64 text-tertiary">
        Select a workspace to manage memory facts
      </div>
    )
  }

  const activeFacts = facts.filter((f) => f.status === 'active')
  const supersededFacts = facts.filter((f) => f.status === 'superseded')
  const pendingContradictions = contradictions.filter((c) => c.status === 'pending')

  return (
    <div className="space-y-6">
      {/* ── Embedding Status Banner ── */}
      <EmbeddingBanner status={embeddingStatus} onBackfill={triggerBackfill} />

      {/* ── Tab Navigation ── */}
      <div className="flex gap-2 border-b border-border pb-2">
        {(['facts', 'contradictions', 'search', 'settings'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === tab
                ? 'bg-accent text-accent-foreground'
                : 'text-secondary hover:text-primary hover:bg-hover'
            }`}
          >
            {tab === 'facts' && `Facts (${activeFacts.length})`}
            {tab === 'contradictions' &&
              `Review${pendingContradictions.length > 0 ? ` (${pendingContradictions.length})` : ''}`}
            {tab === 'search' && 'Search'}
            {tab === 'settings' && 'Capture'}
          </button>
        ))}
      </div>

      {/* ── Facts Tab ── */}
      {activeTab === 'facts' && (
        <div className="space-y-3">
          {/* Explainer panel */}
          <MemoryExplainer />

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-tertiary" />
            <input
              type="text"
              placeholder="Filter facts..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-input border border-border rounded-md text-sm text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Fact cards */}
          {activeFacts.length === 0 ? (
            <div className="text-center py-12 text-tertiary">
              <Database className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No facts recorded yet.</p>
              <p className="text-xs mt-1">
                Facts are automatically extracted from sessions, commits, and documents.
              </p>
            </div>
          ) : (
            activeFacts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                onConfirm={() => confirmFact(fact.id, workspaceId)}
                onArchive={() => archiveFact(fact.id, workspaceId)}
                onDelete={() => deleteFact(fact.id)}
                onScopeToggle={() =>
                  toggleScope(
                    fact.id,
                    !!fact.workspaceId,
                    fact.workspaceId ? undefined : workspaceId
                  )
                }
              />
            ))
          )}

          {/* Superseded section */}
          {supersededFacts.length > 0 && (
            <CollapsibleSection title={`Superseded (${supersededFacts.length})`}>
              {supersededFacts.map((fact) => (
                <FactCard key={fact.id} fact={fact} onDelete={() => deleteFact(fact.id)} dimmed />
              ))}
            </CollapsibleSection>
          )}
        </div>
      )}

      {/* ── Contradictions Tab ── */}
      {activeTab === 'contradictions' && (
        <div className="space-y-3">
          {contradictions.length === 0 ? (
            <div className="text-center py-12 text-tertiary">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No contradictions to review.</p>
            </div>
          ) : (
            contradictions.map((c) => (
              <ContradictionCard key={c.id} contradiction={c} allFacts={facts} />
            ))
          )}
        </div>
      )}

      {/* ── Search Playground Tab ── */}
      {activeTab === 'search' && <SearchPlayground workspaceId={workspaceId} />}

      {/* ── Capture Settings Tab ── */}
      {activeTab === 'settings' && (
        <CaptureSettings
          captureSettings={captureSettings}
          feedStatus={feedStatus}
          feedMessage={feedMessage}
          feedError={feedError}
          onFeedDocument={handleFeedDocument}
          onRegenerateClaudeMd={handleRegenerateClaudeMd}
          onUpdateSettings={updateCaptureSettings}
          workspaceId={workspaceId}
        />
      )}

      {showDiffModal && diffData && (
        <ClaudeMdDiffModal
          existing={diffData.existing}
          proposed={diffData.generated}
          workspacePath={activeWorkspace?.repoPath ?? ''}
          onConfirm={async (content) => {
            if (!activeWorkspace) return
            await window.api.confirmClaudeMd({ workspacePath: activeWorkspace.repoPath, content })
            setShowDiffModal(false)
            setDiffData(null)
          }}
          onDismiss={() => {
            setShowDiffModal(false)
            setDiffData(null)
          }}
          isConfirming={feedStatus === 'running'}
        />
      )}
    </div>
  )
}

// ── Retained sub-components (local to page) ──

function EmbeddingBanner({
  status,
  onBackfill
}: {
  status: MemoryEmbeddingStatus | null
  onBackfill: () => void
}): React.JSX.Element | null {
  if (!status) return null
  if (status.isReady && status.pendingCount === 0) return null

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-warning-muted border border-warning rounded-md text-sm">
      <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
      <div className="flex-1">
        {!status.isReady ? (
          <span>Embedding model offline — facts are saved but semantic search is unavailable.</span>
        ) : (
          <span>
            {status.pendingCount} fact{status.pendingCount !== 1 ? 's' : ''} pending embedding.
          </span>
        )}
      </div>
      {status.isReady && status.pendingCount > 0 && (
        <button
          onClick={onBackfill}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-warning text-warning-foreground rounded hover:opacity-80"
        >
          <Zap className="w-3 h-3" /> Embed Now
        </button>
      )}
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
        className="flex items-center gap-1 text-sm text-secondary hover:text-primary"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {title}
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  Search,
  Trash2,
  Upload,
  Moon,
  Sparkles,
  RefreshCw
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore, useDreamStore } from '@renderer/store'
import { SettingsCard } from '@renderer/components/common'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import type { Memory, MemoryType, WorkspaceFeedTimestamps } from '../../../../shared/types'

const TYPE_BADGES: Record<MemoryType, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-info-muted text-info' },
  feedback: { label: 'Feedback', color: 'bg-mode-build-muted text-mode-build-text' },
  project: { label: 'Project', color: 'bg-success-muted text-success' },
  reference: { label: 'Reference', color: 'bg-mode-plan-muted text-mode-plan-text' }
}

export default function MemorySettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    memories,
    searchQuery,
    feedStatus,
    loadMemories,
    searchMemories,
    deleteMemory,
    setSearchQuery,
    startFeed
  } = useMemoryStore()
  const { triggerDream, currentRun } = useDreamStore()
  const [filterType, setFilterType] = useState<MemoryType | 'all'>('all')
  const [feedTimestamps, setFeedTimestamps] = useState<WorkspaceFeedTimestamps>({})
  const [showDiffModal, setShowDiffModal] = useState(false)
  const [regenerateResult, setRegenerateResult] = useState<{
    existing: string | null
    proposed: string
  } | null>(null)
  const [isConfirmingRegenerate, setIsConfirmingRegenerate] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)

  const refreshFeedTimestamps = useCallback(
    (workspaceId: string) => {
      window.api
        .memoryGetFeedTimestamps({ workspaceId })
        .then(setFeedTimestamps)
        .catch(() => {})
    },
    [setFeedTimestamps]
  )

  useEffect(() => {
    if (activeWorkspace?.id) {
      loadMemories(activeWorkspace.id)
      refreshFeedTimestamps(activeWorkspace.id)
    }
  }, [activeWorkspace?.id, loadMemories, refreshFeedTimestamps])

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query)
      if (activeWorkspace?.id) {
        if (query.trim()) {
          searchMemories(activeWorkspace.id, query)
        } else {
          loadMemories(activeWorkspace.id)
        }
      }
    },
    [activeWorkspace?.id, searchMemories, loadMemories, setSearchQuery]
  )

  const handleRegenerateClaudeMd = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    setIsRegenerating(true)
    try {
      const result = await window.api.memoryRegenerateClaudeMd({
        workspacePath: activeWorkspace.repoPath
      })
      if (result.success) {
        setRegenerateResult({
          existing: result.existing,
          proposed: result.content
        })
        setShowDiffModal(true)
      }
    } finally {
      setIsRegenerating(false)
    }
  }

  const handleConfirmRegenerate = async (editedContent: string): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    setIsConfirmingRegenerate(true)
    try {
      // Write the approved CLAUDE.md to disk — no memory feed needed,
      // CLAUDE.md is already injected via system prompt Layer 4
      await window.api.confirmClaudeMd({
        workspacePath: activeWorkspace.repoPath,
        content: editedContent
      })
      setShowDiffModal(false)
      setRegenerateResult(null)
    } finally {
      setIsConfirmingRegenerate(false)
    }
  }

  const handleFeedDocument = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    const filePath = await window.api.memorySelectDocument()
    if (!filePath) return
    startFeed('document')
    await window.api.memoryFeedDocument({ workspacePath: activeWorkspace.repoPath, filePath })
    if (activeWorkspace.id) {
      loadMemories(activeWorkspace.id)
      refreshFeedTimestamps(activeWorkspace.id)
    }
  }

  const handleTriggerDream = async (): Promise<void> => {
    if (!activeWorkspace?.id) return
    await triggerDream(activeWorkspace.id)
    loadMemories(activeWorkspace.id)
  }

  const filteredMemories =
    filterType === 'all' ? memories : memories.filter((m) => m.type === filterType)

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Database size={20} className="text-mode-plan-text" />
          Auto Memory
        </h2>
        <p className="text-xs text-text-secondary mt-1">
          Persistent cross-session knowledge extracted from conversations. Memories are
          automatically injected into agent prompts.
        </p>
      </div>

      {/* Feed Sources */}
      <div className="mb-6">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Feed Sources
        </h3>
        <div className="grid grid-cols-3 gap-3">
          {/* Regenerate CLAUDE.md — writes file only, no memory feed */}
          <button
            onClick={handleRegenerateClaudeMd}
            disabled={feedStatus === 'running' || isRegenerating}
            title="AI-generates a CLAUDE.md from project sources, lets you review it, then writes to disk"
            aria-label="Regenerate CLAUDE.md — AI-generate from project sources and write to disk"
            className="flex flex-col gap-1.5 p-3 rounded bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <RefreshCw
                size={14}
                className={`text-mode-plan-text ${isRegenerating ? 'animate-spin' : ''}`}
              />
              <span className="text-sm font-medium text-text-primary">
                {isRegenerating ? 'Generating...' : 'Regenerate CLAUDE.md'}
              </span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              AI-generate from project sources and write to disk
            </p>
          </button>

          {/* Feed Document — unique value */}
          <button
            onClick={handleFeedDocument}
            disabled={feedStatus === 'running'}
            title="Opens a file picker to select a document (.md, .txt, .json, .yaml) and extracts memories from it"
            aria-label="Feed Document — Import any .md, .txt, .json, or .yaml file and extract knowledge from it"
            className="flex flex-col gap-1.5 p-3 rounded bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Upload size={14} className="text-success" />
              <span className="text-sm font-medium text-text-primary">Feed Document</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Import any .md, .txt, .json, or .yaml file and extract knowledge from it
            </p>
            <FeedTimestamp timestamp={feedTimestamps['document']} />
          </button>

          {/* Dream — consolidate memories */}
          <button
            onClick={handleTriggerDream}
            disabled={!!currentRun}
            title="Consolidates and deduplicates existing memories using AI, merging overlapping entries and updating importance scores"
            aria-label="Dream — Deduplicate, merge, and score existing memories using AI consolidation"
            className="flex flex-col gap-1.5 p-3 rounded bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Moon size={14} className="text-primary-text" />
              <span className="text-sm font-medium text-text-primary">Dream (Consolidate)</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Deduplicate, merge, and score existing memories using AI consolidation
            </p>
          </button>
        </div>
      </div>

      {/* Memories Section */}
      <div>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Memories
        </h3>

        {/* Search & Filter */}
        <div className="flex flex-col gap-2.5 mb-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search memories..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded bg-surface-overlay border border-border-subtle text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(
              [
                { value: 'all', label: 'All', color: 'bg-white/10 text-text-primary' },
                { value: 'project', label: 'Project', color: 'bg-success-muted text-success' },
                {
                  value: 'reference',
                  label: 'Reference',
                  color: 'bg-mode-plan-muted text-mode-plan-text'
                },
                { value: 'user', label: 'User', color: 'bg-info-muted text-info' },
                { value: 'feedback', label: 'Feedback', color: 'bg-mode-build-muted text-mode-build-text' }
              ] as const
            ).map(({ value, label, color }) => (
              <button
                key={value}
                onClick={() => setFilterType(value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${
                  filterType === value
                    ? `${color} border-current ring-1 ring-current/30`
                    : 'bg-surface-overlay border-border-subtle text-text-muted hover:text-text-secondary hover:border-border-default'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Memory Count — badge style */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-text-secondary px-2 py-0.5 rounded-full bg-surface-overlay border border-border-subtle">
            {filteredMemories.length} {filteredMemories.length === 1 ? 'memory' : 'memories'}
            {filterType !== 'all' && <span className="text-text-muted ml-1">({filterType})</span>}
          </span>
        </div>

        {/* Memory List */}
        <div className="space-y-2">
          {filteredMemories.length === 0 ? (
            <SettingsCard>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={18} className="text-mode-plan-text" />
                <h3 className="text-sm font-semibold text-text-primary">
                  Getting Started with Auto Memory
                </h3>
              </div>
              <p className="text-xs text-text-secondary mb-4 leading-relaxed">
                Memories give your AI agents persistent context across conversations. They're
                extracted automatically during chats, or you can seed them from your project files.
              </p>
              <div className="space-y-2.5">
                <div className="flex items-start gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-success-muted text-success text-xs font-bold flex-shrink-0 mt-0.5">
                    1
                  </span>
                  <div>
                    <span className="text-xs font-medium text-text-primary">Feed Documents</span>
                    <span className="text-xs text-text-muted ml-1">
                      — Import specs, docs, or design files your agents should know
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary-muted text-primary-text text-xs font-bold flex-shrink-0 mt-0.5">
                    2
                  </span>
                  <div>
                    <span className="text-xs font-medium text-text-primary">Dream</span>
                    <span className="text-xs text-text-muted ml-1">
                      — Consolidate after 10+ memories to deduplicate and score
                    </span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-text-muted mt-4 italic">
                Memories are created from conversations (via ```memory blocks) and document feeds.
                Project context from CLAUDE.md is injected automatically via the system prompt.
              </p>
            </SettingsCard>
          ) : (
            filteredMemories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onDelete={() => deleteMemory(memory.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Regenerate CLAUDE.md diff modal */}
      {showDiffModal && regenerateResult && activeWorkspace?.repoPath && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[90vw] h-[85vh] rounded-2xl overflow-hidden border border-border-subtle shadow-2xl flex">
            <ClaudeMdDiffModal
              existing={regenerateResult.existing}
              proposed={regenerateResult.proposed}
              workspacePath={activeWorkspace.repoPath}
              onConfirm={handleConfirmRegenerate}
              onDismiss={() => {
                setShowDiffModal(false)
                setRegenerateResult(null)
              }}
              isConfirming={isConfirmingRegenerate}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function FeedTimestamp({ timestamp }: { timestamp?: string }): React.JSX.Element | null {
  if (!timestamp) return null
  return (
    <p className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
      Last synced{' '}
      {new Date(timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}
    </p>
  )
}

function MemoryCard({
  memory,
  onDelete
}: {
  memory: Memory
  onDelete: () => void
}): React.JSX.Element {
  const badge = TYPE_BADGES[memory.type]

  return (
    <div className="p-3 rounded bg-surface-overlay border border-border-subtle hover:border-border-default transition-colors group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 text-xs rounded-full ${badge.color}`}>{badge.label}</span>
            {memory.importance >= 7 && (
              <span className="text-xs text-mode-build-text">★ High importance</span>
            )}
          </div>
          <h3 className="text-sm font-medium text-text-primary truncate">{memory.title}</h3>
          <p className="text-xs text-text-secondary mt-1 line-clamp-2">{memory.content}</p>
          {memory.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {memory.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-surface-float text-text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onDelete}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-danger-muted text-danger transition-all"
          aria-label="Delete memory"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

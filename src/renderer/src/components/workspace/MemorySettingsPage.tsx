import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  Search,
  Trash2,
  FileText,
  Code2,
  Upload,
  Moon,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Sparkles
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore, useDreamStore } from '@renderer/store'
import { SettingsCard } from '@renderer/components/common'
import type { Memory, MemoryType } from '../../../../shared/types'

const TYPE_BADGES: Record<MemoryType, { label: string; color: string }> = {
  user: { label: 'User', color: 'bg-blue-500/20 text-blue-300' },
  feedback: { label: 'Feedback', color: 'bg-amber-500/20 text-amber-300' },
  project: { label: 'Project', color: 'bg-emerald-500/20 text-emerald-300' },
  reference: { label: 'Reference', color: 'bg-purple-500/20 text-purple-300' }
}

export default function MemorySettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    memories,
    searchQuery,
    feedStatus,
    feedMessage,
    feedError,
    loadMemories,
    searchMemories,
    deleteMemory,
    setSearchQuery,
    startFeed,
    dismissFeed
  } = useMemoryStore()
  const { triggerDream, currentRun } = useDreamStore()
  const [filterType, setFilterType] = useState<MemoryType | 'all'>('all')

  useEffect(() => {
    if (activeWorkspace?.id) {
      loadMemories(activeWorkspace.id)
    }
  }, [activeWorkspace?.id, loadMemories])

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

  const handleFeedClaudeMd = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    startFeed('claude-md')
    await window.api.memoryFeedClaudeMd({ workspacePath: activeWorkspace.repoPath })
    if (activeWorkspace.id) loadMemories(activeWorkspace.id)
  }

  const handleFeedCodebase = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    startFeed('codebase')
    await window.api.memoryFeedCodebase({ workspacePath: activeWorkspace.repoPath })
    if (activeWorkspace.id) loadMemories(activeWorkspace.id)
  }

  const handleFeedDocument = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    const filePath = await window.api.memorySelectDocument()
    if (!filePath) return
    startFeed('document')
    await window.api.memoryFeedDocument({ workspacePath: activeWorkspace.repoPath, filePath })
    if (activeWorkspace.id) loadMemories(activeWorkspace.id)
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
          <Database size={20} className="text-purple-400" />
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
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleFeedClaudeMd}
            disabled={feedStatus === 'running'}
            title="Reads CLAUDE.md from your workspace root and extracts project conventions, tech stack, and patterns into memories"
            aria-label="Feed CLAUDE.md — Extract project conventions, tech stack, and patterns from your CLAUDE.md"
            className="flex flex-col gap-1.5 p-3 rounded-xl bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-purple-400" />
              <span className="text-sm font-medium text-text-primary">Feed CLAUDE.md</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Extract project conventions, tech stack, and patterns from your CLAUDE.md
            </p>
          </button>

          <button
            onClick={handleFeedCodebase}
            disabled={feedStatus === 'running'}
            title="Scans key project files (package.json, tsconfig, directory tree) and creates structural memories about your codebase"
            aria-label="Feed Codebase — Analyze project structure, dependencies, and key files for architectural context"
            className="flex flex-col gap-1.5 p-3 rounded-xl bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Code2 size={14} className="text-blue-400" />
              <span className="text-sm font-medium text-text-primary">Feed Codebase</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Analyze project structure, dependencies, and key files for architectural context
            </p>
          </button>

          <button
            onClick={handleFeedDocument}
            disabled={feedStatus === 'running'}
            title="Opens a file picker to select a document (.md, .txt, .json, .yaml) and extracts memories from it"
            aria-label="Feed Document — Import any .md, .txt, .json, or .yaml file and extract knowledge from it"
            className="flex flex-col gap-1.5 p-3 rounded-xl bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Upload size={14} className="text-emerald-400" />
              <span className="text-sm font-medium text-text-primary">Feed Document</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Import any .md, .txt, .json, or .yaml file and extract knowledge from it
            </p>
          </button>

          <button
            onClick={handleTriggerDream}
            disabled={!!currentRun}
            title="Consolidates and deduplicates existing memories using AI, merging overlapping entries and updating importance scores"
            aria-label="Dream — Deduplicate, merge, and score existing memories using AI consolidation"
            className="flex flex-col gap-1.5 p-3 rounded-xl bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <Moon size={14} className="text-indigo-400" />
              <span className="text-sm font-medium text-text-primary">Dream (Consolidate)</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              Deduplicate, merge, and score existing memories using AI consolidation
            </p>
          </button>
        </div>
      </div>

      {/* Inline feed status */}
      {feedStatus === 'running' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 border border-primary/20 text-sm mb-6">
          <Loader2 size={14} className="text-primary animate-spin" />
          <span className="text-text-secondary text-xs flex-1">{feedMessage ?? 'Processing...'}</span>
        </div>
      )}
      {feedStatus === 'error' && feedError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-900/20 border border-red-800/30 text-sm mb-6">
          <AlertCircle size={14} className="text-red-400" />
          <span className="text-red-300 text-xs flex-1">{feedError}</span>
          <button
            onClick={dismissFeed}
            className="text-xs text-red-400 hover:text-red-300"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}
      {feedStatus === 'completed' && feedMessage && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-900/20 border border-emerald-800/30 text-sm mb-6">
          <CheckCircle2 size={14} className="text-emerald-400" />
          <span className="text-emerald-200 text-xs flex-1">{feedMessage}</span>
          <button
            onClick={dismissFeed}
            className="text-xs text-emerald-400 hover:text-emerald-300"
            aria-label="Dismiss message"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Memories Section */}
      <div>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Memories
        </h3>

        {/* Search & Filter */}
        <div className="flex gap-3 mb-3">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search memories..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface-overlay border border-border-subtle text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as MemoryType | 'all')}
            className="px-3 py-2 text-sm rounded-xl bg-surface-overlay border border-border-subtle text-text-primary"
          >
            <option value="all">All Types</option>
            <option value="user">User</option>
            <option value="feedback">Feedback</option>
            <option value="project">Project</option>
            <option value="reference">Reference</option>
          </select>
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
                <Sparkles size={18} className="text-purple-400" />
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
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex-shrink-0 mt-0.5">
                    1
                  </span>
                  <div>
                    <span className="text-xs font-medium text-text-primary">Feed CLAUDE.md</span>
                    <span className="text-xs text-text-muted ml-1">
                      — Extracts project conventions and tech stack
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex-shrink-0 mt-0.5">
                    2
                  </span>
                  <div>
                    <span className="text-xs font-medium text-text-primary">Feed Codebase</span>
                    <span className="text-xs text-text-muted ml-1">
                      — Scans project structure and key files
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold flex-shrink-0 mt-0.5">
                    3
                  </span>
                  <div>
                    <span className="text-xs font-medium text-text-primary">Feed Documents</span>
                    <span className="text-xs text-text-muted ml-1">
                      — Import any additional docs your agents should know
                    </span>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-bold flex-shrink-0 mt-0.5">
                    4
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
                Memories are also created automatically during conversations — start chatting and
                they'll accumulate over time.
              </p>
            </SettingsCard>
          ) : (
            filteredMemories.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} onDelete={() => deleteMemory(memory.id)} />
            ))
          )}
        </div>
      </div>
    </div>
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
    <div className="p-3 rounded-xl bg-surface-overlay border border-border-subtle hover:border-border-default transition-colors group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 text-xs rounded-full ${badge.color}`}>{badge.label}</span>
            {memory.importance >= 7 && (
              <span className="text-xs text-amber-400">★ High importance</span>
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
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-800/40 text-red-400 transition-all"
          aria-label="Delete memory"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

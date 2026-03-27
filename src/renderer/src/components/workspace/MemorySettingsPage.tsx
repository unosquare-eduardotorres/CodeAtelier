import { useState, useEffect, useCallback } from 'react'
import { Database, Search, Trash2, FileText, Code2, Upload, Moon } from 'lucide-react'
import { useWorkspaceStore, useMemoryStore, useDreamStore } from '@renderer/store'
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
    loadMemories,
    searchMemories,
    deleteMemory,
    setSearchQuery,
    startFeed
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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Database size={20} className="text-purple-400" />
          Auto Memory
        </h2>
        <p className="text-sm text-secondary mt-1">
          Persistent cross-session knowledge extracted from conversations. Memories are
          automatically injected into agent prompts.
        </p>
      </div>

      {/* Feed Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleFeedClaudeMd}
          disabled={feedStatus === 'running'}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary transition-colors disabled:opacity-50"
        >
          <FileText size={14} />
          Feed CLAUDE.md
        </button>
        <button
          onClick={handleFeedCodebase}
          disabled={feedStatus === 'running'}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary transition-colors disabled:opacity-50"
        >
          <Code2 size={14} />
          Feed Codebase
        </button>
        <button
          onClick={handleFeedDocument}
          disabled={feedStatus === 'running'}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary transition-colors disabled:opacity-50"
        >
          <Upload size={14} />
          Feed Document
        </button>
        <button
          onClick={handleTriggerDream}
          disabled={!!currentRun}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-indigo-900/40 hover:bg-indigo-800/40 text-indigo-300 hover:text-indigo-200 transition-colors disabled:opacity-50"
        >
          <Moon size={14} />
          Dream (Consolidate)
        </button>
      </div>

      {/* Search & Filter */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search memories..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-md bg-surface-2 border border-surface-3 text-primary placeholder:text-tertiary focus:outline-none focus:border-purple-500/50"
          />
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as MemoryType | 'all')}
          className="px-3 py-2 text-sm rounded-md bg-surface-2 border border-surface-3 text-primary"
        >
          <option value="all">All Types</option>
          <option value="user">User</option>
          <option value="feedback">Feedback</option>
          <option value="project">Project</option>
          <option value="reference">Reference</option>
        </select>
      </div>

      {/* Memory Count */}
      <p className="text-xs text-tertiary">
        {filteredMemories.length} {filteredMemories.length === 1 ? 'memory' : 'memories'}
        {filterType !== 'all' && ` (${filterType})`}
      </p>

      {/* Memory List */}
      <div className="space-y-2">
        {filteredMemories.length === 0 ? (
          <div className="text-center py-12 text-tertiary text-sm">
            <Database size={32} className="mx-auto mb-3 opacity-40" />
            <p>No memories yet.</p>
            <p className="mt-1 text-xs">
              Memories are created automatically during conversations, or you can feed sources
              above.
            </p>
          </div>
        ) : (
          filteredMemories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onDelete={() => deleteMemory(memory.id)} />
          ))
        )}
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
    <div className="p-3 rounded-lg bg-surface-2 border border-surface-3 hover:border-surface-4 transition-colors group">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-2 py-0.5 text-xs rounded-full ${badge.color}`}>{badge.label}</span>
            {memory.importance >= 7 && (
              <span className="text-xs text-amber-400">★ High importance</span>
            )}
          </div>
          <h3 className="text-sm font-medium text-primary truncate">{memory.title}</h3>
          <p className="text-xs text-secondary mt-1 line-clamp-2">{memory.content}</p>
          {memory.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {memory.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-surface-3 text-tertiary"
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

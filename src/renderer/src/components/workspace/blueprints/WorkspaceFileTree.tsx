/**
 * WorkspaceFileTree — modal file browser for selecting workspace files as reference documents.
 *
 * Uses the listDirectory IPC to lazily load directory contents. Supports multi-select
 * with checkboxes and returns selected files as ReferenceDocument[] entries.
 */

import { useState, useCallback, useEffect } from 'react'
import { ChevronRight, ChevronDown, FileText, FolderOpen, Folder, X, Check } from 'lucide-react'
import type { ReferenceDocument } from '../../../../../shared/blueprint-types'

interface WorkspaceFileTreeProps {
  workspaceId: string
  isOpen: boolean
  onClose: () => void
  onSelectFiles: (files: ReferenceDocument[]) => void
}

interface DirectoryEntry {
  name: string
  type: 'file' | 'directory'
  relativePath: string
}

interface TreeNodeState {
  expanded: boolean
  children: DirectoryEntry[] | null
  loading: boolean
}

export default function WorkspaceFileTree({
  workspaceId,
  isOpen,
  onClose,
  onSelectFiles
}: WorkspaceFileTreeProps): React.JSX.Element | null {
  const [nodes, setNodes] = useState<Map<string, TreeNodeState>>(new Map())
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  // Load root directory on open
  useEffect(() => {
    if (!isOpen) return
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on modal open */
    setSelected(new Set())
    setNodes(new Map())
    setLoading(true)
    /* eslint-enable react-hooks/set-state-in-effect */

    window.api
      .listDirectory({ workspaceId })
      .then((entries) => {
        setRootEntries(entries)
        setLoading(false)
      })
      .catch(() => {
        setRootEntries([])
        setLoading(false)
      })
  }, [isOpen, workspaceId])

  const toggleDirectory = useCallback(
    async (relativePath: string) => {
      const existing = nodes.get(relativePath)
      if (existing?.expanded) {
        // Collapse
        setNodes((prev) => {
          const next = new Map(prev)
          next.set(relativePath, { ...existing, expanded: false })
          return next
        })
        return
      }

      if (existing?.children) {
        // Already loaded — just expand
        setNodes((prev) => {
          const next = new Map(prev)
          next.set(relativePath, { ...existing, expanded: true })
          return next
        })
        return
      }

      // Load children
      setNodes((prev) => {
        const next = new Map(prev)
        next.set(relativePath, { expanded: true, children: null, loading: true })
        return next
      })

      try {
        const children = await window.api.listDirectory({ workspaceId, relativePath })
        setNodes((prev) => {
          const next = new Map(prev)
          next.set(relativePath, { expanded: true, children, loading: false })
          return next
        })
      } catch {
        setNodes((prev) => {
          const next = new Map(prev)
          next.set(relativePath, { expanded: true, children: [], loading: false })
          return next
        })
      }
    },
    [nodes, workspaceId]
  )

  const toggleSelect = useCallback((relativePath: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(relativePath)) {
        next.delete(relativePath)
      } else {
        next.add(relativePath)
      }
      return next
    })
  }, [])

  const handleAdd = useCallback(() => {
    const docs: ReferenceDocument[] = Array.from(selected).map((path) => ({
      type: 'workspace-file' as const,
      path,
      name: path.split('/').pop() || path
    }))
    onSelectFiles(docs)
    onClose()
  }, [selected, onSelectFiles, onClose])

  if (!isOpen) return null

  const renderEntries = (entries: DirectoryEntry[], depth: number): React.JSX.Element[] =>
    entries.map((entry) => {
      const nodeState = nodes.get(entry.relativePath)
      const isExpanded = nodeState?.expanded ?? false
      const isLoading = nodeState?.loading ?? false
      const isSelected = selected.has(entry.relativePath)

      return (
        <div key={entry.relativePath}>
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs cursor-pointer transition-colors hover:bg-surface-hover ${
              isSelected ? 'bg-primary-muted/50' : ''
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {entry.type === 'directory' ? (
              <button
                type="button"
                onClick={() => toggleDirectory(entry.relativePath)}
                className="flex items-center gap-1 text-text-secondary hover:text-text-primary flex-1 min-w-0"
              >
                {isExpanded ? (
                  <ChevronDown size={12} className="flex-shrink-0" />
                ) : (
                  <ChevronRight size={12} className="flex-shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen size={13} className="flex-shrink-0 text-amber-400" />
                ) : (
                  <Folder size={13} className="flex-shrink-0 text-amber-400" />
                )}
                <span className="truncate">{entry.name}</span>
                {isLoading && (
                  <span className="text-[10px] text-text-muted animate-pulse ml-1">loading…</span>
                )}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => toggleSelect(entry.relativePath)}
                  className={`flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 transition-colors ${
                    isSelected
                      ? 'bg-emerald-500 border-emerald-500'
                      : 'border-border-subtle hover:border-emerald-400'
                  }`}
                >
                  {isSelected && <Check size={10} className="text-white" />}
                </button>
                <button
                  type="button"
                  onClick={() => toggleSelect(entry.relativePath)}
                  className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary flex-1 min-w-0 text-left"
                >
                  <FileText size={13} className="flex-shrink-0 text-blue-400" />
                  <span className="truncate">{entry.name}</span>
                </button>
              </>
            )}
          </div>

          {/* Render children if expanded */}
          {entry.type === 'directory' && isExpanded && nodeState?.children && (
            <div>{renderEntries(nodeState.children, depth + 1)}</div>
          )}
        </div>
      )
    })

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div data-testid="workspace-file-tree" className="w-full max-w-md bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-text-primary">Browse Workspace Files</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[200px]">
          {loading ? (
            <div className="text-xs text-text-muted text-center py-8 animate-pulse">
              Loading workspace files…
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="text-xs text-text-muted text-center py-8">
              No files found in workspace
            </div>
          ) : (
            renderEntries(rootEntries, 0)
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle bg-surface-overlay/30">
          <span className="text-xs text-text-muted">
            {selected.size} file{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button
            type="button"
            onClick={handleAdd}
            disabled={selected.size === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check size={14} />
            Add Selected
          </button>
        </div>
      </div>
    </div>
  )
}

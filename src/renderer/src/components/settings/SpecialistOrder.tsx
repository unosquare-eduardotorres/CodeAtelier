import { useState, useEffect, useCallback } from 'react'
import { GripVertical, ChevronUp, ChevronDown, Loader2 } from 'lucide-react'
import { useSpecialistStore, useWorkspaceStore } from '@renderer/store'
import { Avatar } from '@renderer/components/common'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import type { Specialist } from '../../../../shared/types'

export default function SpecialistOrder(): React.JSX.Element {
  const { specialists, reorderSpecialists } = useSpecialistStore()
  const activeWs = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const mannequinKey = activeWs ? getWorkspaceMannequin(activeWs.id, workspaces) : 'mannequin-main'
  const [orderedList, setOrderedList] = useState<Specialist[]>([])
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Initialize from active specialists sorted by priority (exclude user — always priority -1)
  useEffect(() => {
    const active = [...specialists]
      .filter((s) => s.isActive && s.agentId !== 'user')
      .sort((a, b) => a.priority - b.priority)
    setOrderedList(active)
  }, [specialists])

  const handleDragStart = (index: number): void => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return
    const updated = [...orderedList]
    const [moved] = updated.splice(draggedIndex, 1)
    updated.splice(index, 0, moved)
    setOrderedList(updated)
    setDraggedIndex(index)
  }

  const handleDragEnd = async (): Promise<void> => {
    setDraggedIndex(null)
    setIsSaving(true)
    try {
      await reorderSpecialists(orderedList.map((s) => s.id))
    } finally {
      setIsSaving(false)
    }
  }

  const moveItem = useCallback(
    async (from: number, to: number) => {
      const updated = [...orderedList]
      const [moved] = updated.splice(from, 1)
      updated.splice(to, 0, moved)
      setOrderedList(updated)
      setIsSaving(true)
      try {
        await reorderSpecialists(updated.map((s) => s.id))
      } finally {
        setIsSaving(false)
      }
    },
    [orderedList, reorderSpecialists]
  )

  if (orderedList.length === 0) return <></>

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Specialist Priority Order</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-4">
        Drag to reorder. Specialists listed first are presented first to the generalist when
        decomposing tasks into sub-tasks.
      </p>
      <div className="space-y-1">
        {orderedList.map((specialist, index) => (
          <div
            key={specialist.id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing
              ${
                draggedIndex === index
                  ? 'border-primary/50 bg-primary/5 scale-[1.02] shadow-md'
                  : 'border-border-subtle bg-surface-base hover:bg-surface-overlay'
              }
            `}
          >
            <GripVertical size={14} className="text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted w-5 font-mono">{index + 1}</span>
            <Avatar
              avatarKey={specialist.agentId === 'user' ? 'user' : mannequinKey}
              size="sm"
              accentColor={specialist.color}
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                {specialist.displayName}
              </span>
              {specialist.alias && (
                <span className="text-xs text-text-muted ml-1.5">({specialist.alias})</span>
              )}
            </div>
            {/* Up/Down buttons for accessibility */}
            <div className="flex flex-col gap-0.5">
              <button
                disabled={index === 0}
                onClick={() => moveItem(index, index - 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronUp size={12} />
              </button>
              <button
                disabled={index === orderedList.length - 1}
                onClick={() => moveItem(index, index + 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {isSaving && (
        <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" /> Saving order...
        </p>
      )}
    </div>
  )
}

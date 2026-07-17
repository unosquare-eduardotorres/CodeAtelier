/**
 * TrackPickerModal — Modal for selecting which tracks to create separate
 * conversations for in the "Split by Track" audit handoff flow.
 */

import { useState, useCallback } from 'react'
import { SplitSquareVertical, X } from 'lucide-react'
import type { AuditTrackId } from '../../../../../shared/types'

interface TrackOption {
  id: AuditTrackId
  name: string
  issueCount: number
  score: number | null
}

interface TrackPickerModalProps {
  open: boolean
  tracks: TrackOption[]
  onConfirm: (selectedTracks: AuditTrackId[]) => void
  onClose: () => void
}

export default function TrackPickerModal({
  open,
  tracks,
  onConfirm,
  onClose
}: TrackPickerModalProps): React.JSX.Element | null {
  const [selected, setSelected] = useState<Set<AuditTrackId>>(() => {
    // Default: check all tracks with issues
    return new Set(tracks.filter((t) => t.issueCount > 0).map((t) => t.id))
  })

  const toggleTrack = useCallback((trackId: AuditTrackId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }, [])

  const handleConfirm = useCallback(() => {
    onConfirm([...selected])
  }, [selected, onConfirm])

  if (!open) return null

  const selectedCount = selected.size

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 rounded-xl bg-surface-raised border border-border-subtle shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <SplitSquareVertical size={16} className="text-primary-text" />
            <h3 className="text-base font-bold text-text-primary">Create chats by auditor</h3>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Subtitle */}
        <p className="px-5 pt-3 text-sm text-text-secondary">
          Each selected auditor will get its own chat conversation with specific findings.
        </p>

        {/* Track list */}
        <div className="px-5 py-3 space-y-1 max-h-[320px] overflow-y-auto">
          {tracks.map((track) => {
            const hasIssues = track.issueCount > 0
            const isChecked = selected.has(track.id)

            return (
              <label
                key={track.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${hasIssues ? 'hover:bg-surface-overlay' : 'opacity-50 cursor-not-allowed'} ${isChecked ? 'bg-primary/5' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={!hasIssues}
                  onChange={() => hasIssues && toggleTrack(track.id)}
                  className="w-4 h-4 rounded border-border-subtle text-primary-text focus:ring-primary/30"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">{track.name}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {track.score != null && (
                    <span className="text-[11px] text-text-muted">{track.score}/100</span>
                  )}
                  <span
                    className={`text-xs font-medium ${
                      hasIssues ? 'text-warning' : 'text-text-muted'
                    }`}
                  >
                    {track.issueCount} issue{track.issueCount !== 1 ? 's' : ''}
                  </span>
                </div>
              </label>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={selectedCount === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary/15 text-primary-text hover:bg-primary/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <SplitSquareVertical size={14} />
            Create {selectedCount} Conversation{selectedCount !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

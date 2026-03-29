import { RefreshCw, Plus, Pencil, Trash2, Loader2 } from 'lucide-react'
import type { SyncDiff } from '../../../../shared/types'

interface SyncBannerProps {
  syncDiff: SyncDiff
  isSyncing: boolean
  onReviewSync: () => void
  onAutoSync: () => void
}

export default function SyncBanner({
  syncDiff,
  isSyncing,
  onReviewSync,
  onAutoSync
}: SyncBannerProps): React.JSX.Element | null {
  if (!syncDiff.hasChanges) return null

  const newCount = syncDiff.newSpecialists.length
  const updatedCount = syncDiff.updatedSpecialists.length
  const removedCount = syncDiff.removedSpecialists.length
  const newSkillsCount = syncDiff.newSkills.length

  return (
    <div className="bg-primary-muted border border-primary/30 rounded p-4">
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary-muted flex-shrink-0">
          <RefreshCw size={16} className="text-primary-text" />
        </div>

        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-text-primary">YAML Sync Available</h4>
          <div className="flex flex-wrap items-center gap-3 mt-1.5">
            {newCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-success">
                <Plus size={12} />
                {newCount} new agent{newCount !== 1 ? 's' : ''}
              </span>
            )}
            {newSkillsCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-success">
                <Plus size={12} />
                {newSkillsCount} new skill{newSkillsCount !== 1 ? 's' : ''}
              </span>
            )}
            {updatedCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-mode-build-text">
                <Pencil size={12} />
                {updatedCount} updated
              </span>
            )}
            {removedCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-danger">
                <Trash2 size={12} />
                {removedCount} removed
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-muted mt-1">
            Workspace YAML files differ from the local database
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onReviewSync}
            disabled={isSyncing}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary bg-surface-raised hover:bg-surface-overlay rounded-lg transition-colors disabled:opacity-50"
          >
            Review & Sync
          </button>
          {newCount > 0 && updatedCount === 0 && removedCount === 0 && (
            <button
              onClick={onAutoSync}
              disabled={isSyncing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-lg transition-colors disabled:opacity-50"
            >
              {isSyncing ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Syncing...
                </>
              ) : (
                'Import All'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

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
    <div className="bg-indigo-950/40 border border-indigo-500/30 rounded-xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500/20 flex-shrink-0">
          <RefreshCw size={16} className="text-indigo-400" />
        </div>

        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-200">YAML Sync Available</h4>
          <div className="flex flex-wrap items-center gap-3 mt-1.5">
            {newCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <Plus size={12} />
                {newCount} new agent{newCount !== 1 ? 's' : ''}
              </span>
            )}
            {newSkillsCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <Plus size={12} />
                {newSkillsCount} new skill{newSkillsCount !== 1 ? 's' : ''}
              </span>
            )}
            {updatedCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <Pencil size={12} />
                {updatedCount} updated
              </span>
            )}
            {removedCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-red-400">
                <Trash2 size={12} />
                {removedCount} removed
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Workspace YAML files differ from the local database
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onReviewSync}
            disabled={isSyncing}
            className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
          >
            Review & Sync
          </button>
          {newCount > 0 && updatedCount === 0 && removedCount === 0 && (
            <button
              onClick={onAutoSync}
              disabled={isSyncing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
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

import React from 'react'
import { GitBranch, Check, Pencil, Loader2 } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { RepoInfo } from '../../../../../shared/types'

interface GitConfigSectionProps {
  activeWorkspacePath: string
  localRepoInfo: RepoInfo | null
  remoteUrl: string
  isEditingRemote: boolean
  remoteSaved: boolean
  isSavingRemote: boolean
  isInitializingRepo: boolean
  onRemoteUrlChange: (url: string) => void
  onEditRemote: () => void
  onCancelEditRemote: () => void
  onSaveRemote: () => void
  onInitRepo: () => void
}

export default function GitConfigSection({
  activeWorkspacePath,
  localRepoInfo,
  remoteUrl,
  isEditingRemote,
  remoteSaved,
  isSavingRemote,
  isInitializingRepo,
  onRemoteUrlChange,
  onEditRemote,
  onCancelEditRemote,
  onSaveRemote,
  onInitRepo
}: GitConfigSectionProps): React.JSX.Element {
  const hasRemote = localRepoInfo?.hasRemote && localRepoInfo?.remoteUrl

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          Repository
        </h3>
        {localRepoInfo?.isRepo && (
          <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
            <Check size={10} />
            Initialized
          </span>
        )}
      </div>

      <SettingsCard>
        {localRepoInfo?.isRepo ? (
          <>
            {/* Fix #6: Grid layout for info rows */}
            <div className="grid grid-cols-[80px_1fr] gap-y-2.5 gap-x-3 items-baseline">
              <span className="text-xs text-text-secondary">Path</span>
              <span className="text-sm text-text-body font-mono truncate">
                {activeWorkspacePath}
              </span>
              {/* Fix #1: Removed redundant Status row — badge handles it */}
              <span className="text-xs text-text-secondary">Branch</span>
              <span className="text-sm text-text-body font-mono">
                {localRepoInfo.currentBranch}
              </span>
              {/* Fix #9: Removed colon from "Remote:" */}
              <span className="text-xs text-text-secondary">Remote</span>
              {hasRemote && !isEditingRemote ? (
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-text-body font-mono truncate">
                    {localRepoInfo.remoteUrl}
                  </span>
                  {/* Fix #8: Show saved indicator */}
                  {remoteSaved ? (
                    <span className="text-xs text-success flex items-center gap-0.5 shrink-0">
                      <Check size={10} />
                      Saved
                    </span>
                  ) : (
                    <button
                      onClick={onEditRemote}
                      className="text-text-muted hover:text-primary-text transition-colors shrink-0"
                      title="Edit remote URL"
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                </span>
              ) : (
                <div className="flex gap-2 items-center min-w-0">
                  <input
                    type="text"
                    value={remoteUrl}
                    onChange={(e) => onRemoteUrlChange(e.target.value)}
                    placeholder="https://github.com/user/repo.git"
                    className="flex-1 px-2 py-1 bg-surface-base border border-border-default rounded text-xs text-text-body font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent min-w-0"
                  />
                  <button
                    onClick={onSaveRemote}
                    disabled={isSavingRemote || !remoteUrl.trim()}
                    className="px-2 py-1 text-xs bg-primary hover:bg-primary-hover text-white rounded disabled:opacity-50 transition-colors flex items-center gap-1 shrink-0"
                  >
                    {isSavingRemote ? <Loader2 size={10} className="animate-spin" /> : 'Save'}
                  </button>
                  {isEditingRemote && (
                    <button
                      onClick={onCancelEditRemote}
                      className="text-xs text-text-muted hover:text-text-secondary shrink-0"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-surface-base flex items-center justify-center shrink-0">
              <GitBranch size={16} className="text-text-secondary" />
            </div>
            <div className="flex-1">
              <p className="text-sm text-text-body">Not a Git repository</p>
              <p className="text-xs text-text-secondary">Initialize git to enable version control</p>
            </div>
            <button
              onClick={onInitRepo}
              disabled={isInitializingRepo}
              className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
            >
              {isInitializingRepo ? <Loader2 size={12} className="animate-spin" /> : 'Initialize Git'}
            </button>
          </div>
        )}
      </SettingsCard>
    </section>
  )
}

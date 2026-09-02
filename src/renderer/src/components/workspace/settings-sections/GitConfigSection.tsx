import React from 'react'
import { GitBranch, Check, Pencil, Loader2 } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { FOLLOW_CHECKOUT } from '../../../../../shared/constants'
import { summariseResolvedBase } from '../../../../../shared/blueprint-base-summary'
import type { RepoInfo } from '../../../../../shared/types'
import type { ResolvedBlueprintBase } from '../../../../../shared/blueprint-types'

interface GitConfigSectionProps {
  activeWorkspacePath: string
  localRepoInfo: RepoInfo | null
  remoteUrl: string
  isEditingRemote: boolean
  remoteSaved: boolean
  isSavingRemote: boolean
  isInitializingRepo: boolean
  /** Raw `blueprintBaseBranch` setting. Undefined and the sentinel both mean "follow the checkout". */
  baseBranch: string | undefined
  /** Local branch names the base may be pinned to. */
  branches: string[]
  /** What the chain currently resolves to — null while it is still loading. */
  resolvedBase: ResolvedBlueprintBase | null
  onRemoteUrlChange: (url: string) => void
  onEditRemote: () => void
  onCancelEditRemote: () => void
  onSaveRemote: () => void
  onInitRepo: () => void
  onBaseBranchChange: (value: string) => void
}

export default function GitConfigSection({
  activeWorkspacePath,
  localRepoInfo,
  remoteUrl,
  isEditingRemote,
  remoteSaved,
  isSavingRemote,
  isInitializingRepo,
  baseBranch,
  branches,
  resolvedBase,
  onRemoteUrlChange,
  onEditRemote,
  onCancelEditRemote,
  onSaveRemote,
  onInitRepo,
  onBaseBranchChange
}: GitConfigSectionProps): React.JSX.Element {
  const hasRemote = localRepoInfo?.hasRemote && localRepoInfo?.remoteUrl

  // Absence and the sentinel are the same state, and the select has to collapse
  // them into one option or it would render blank for every existing workspace.
  const pinned = baseBranch && baseBranch !== FOLLOW_CHECKOUT ? baseBranch : null
  // A pin whose branch has since been deleted still resolves — to the NEXT rule
  // in the chain. Dropping it from the list would make that fall-through
  // invisible, which is the failure this row exists to prevent.
  const pinIsStale = pinned !== null && !branches.includes(pinned)
  const currentBranch = localRepoInfo?.currentBranch

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
            <div className="grid grid-cols-[130px_1fr] gap-y-2.5 gap-x-3 items-baseline">
              <span className="text-xs text-text-secondary">Path</span>
              <span className="text-sm text-text-body font-mono truncate">
                {activeWorkspacePath}
              </span>
              {/* Fix #1: Removed redundant Status row — badge handles it */}
              {/*
                "Branch" read as "the branch this workspace works on", which is
                exactly the misreading that let a wrong fork point go unnoticed.
                It is the checkout and nothing more — the row below is the one
                that decides where new work starts.
              */}
              <span className="text-xs text-text-secondary">Checked out</span>
              <span className="text-sm text-text-body font-mono">
                {localRepoInfo.currentBranch}
              </span>

              <span className="text-xs text-text-secondary">Base for new work</span>
              <div className="min-w-0 space-y-1.5">
                <select
                  data-testid="blueprint-base-branch"
                  value={pinned ?? FOLLOW_CHECKOUT}
                  onChange={(e) => onBaseBranchChange(e.target.value)}
                  className="w-full px-2 py-1 bg-surface-base border border-border-default rounded text-xs text-text-body font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                >
                  <option value={FOLLOW_CHECKOUT}>
                    Follow checked-out branch{currentBranch ? ` (${currentBranch})` : ''}
                  </option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                  {pinIsStale && pinned && (
                    <option value={pinned}>{pinned} — no longer exists</option>
                  )}
                </select>

                {!pinned && (
                  <p className="text-xs text-text-muted">
                    Blueprints fork from whatever is checked out. Pin a base to make this
                    deliberate.
                    {currentBranch && (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => onBaseBranchChange(currentBranch)}
                          className="text-primary-text hover:underline"
                        >
                          Pin {currentBranch}
                        </button>
                      </>
                    )}
                  </p>
                )}

                {pinIsStale && (
                  <p className="text-xs text-warning">
                    {pinned} no longer exists, so new work falls through to the next rule below.
                  </p>
                )}

                {resolvedBase && (
                  <p data-testid="blueprint-base-effective" className="text-xs text-text-secondary">
                    {summariseResolvedBase(resolvedBase)}
                  </p>
                )}
              </div>
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
              <p className="text-xs text-text-secondary">
                Initialize git to enable version control
              </p>
            </div>
            <button
              data-testid="git-init-btn"
              onClick={onInitRepo}
              disabled={isInitializingRepo}
              className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
            >
              {isInitializingRepo ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                'Initialize Git'
              )}
            </button>
          </div>
        )}
      </SettingsCard>
    </section>
  )
}

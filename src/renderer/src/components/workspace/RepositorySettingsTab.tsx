import { useState, useEffect } from 'react'
import { GitBranch, Check, X, Loader2, ExternalLink, AlertTriangle, Pencil } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { SettingsCard } from '@renderer/components/common'
import type { RepoInfo } from '../../../../shared/types'

export default function RepositorySettingsTab(): React.JSX.Element {
  const { activeWorkspace, repoInfo, githubStatus, loadRepoInfo, loadGitHubStatus } =
    useWorkspaceStore()

  const [localRepoInfo, setLocalRepoInfo] = useState<RepoInfo | null>(repoInfo)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [isSavingRemote, setIsSavingRemote] = useState(false)
  const [isInitializingRepo, setIsInitializingRepo] = useState(false)
  const [isEditingRemote, setIsEditingRemote] = useState(false)
  const [remoteSaved, setRemoteSaved] = useState(false)

  // GitHub token state
  const [token, setToken] = useState('')
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenSuccess, setTokenSuccess] = useState<string | null>(null)

  // Automation toggles
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  useEffect(() => {
    if (activeWorkspace) {
      loadRepoInfo(activeWorkspace.id)
      loadGitHubStatus(activeWorkspace.id)
      window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id }).then(setSettings)
    }
  }, [activeWorkspace, loadRepoInfo, loadGitHubStatus])

  useEffect(() => {
    // Sync from store — intentional when parent repoInfo changes
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalRepoInfo(repoInfo)
    if (repoInfo?.remoteUrl) {
      setRemoteUrl(repoInfo.remoteUrl)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [repoInfo])

  const handleInitRepo = async (): Promise<void> => {
    if (!activeWorkspace) return
    setIsInitializingRepo(true)
    try {
      await window.api.initRepo({ workspaceId: activeWorkspace.id })
      await loadRepoInfo(activeWorkspace.id)
    } catch (e) {
      console.error('Failed to init repo:', e)
    }
    setIsInitializingRepo(false)
  }

  const handleSaveRemote = async (): Promise<void> => {
    if (!activeWorkspace || !remoteUrl.trim()) return
    setIsSavingRemote(true)
    try {
      await window.api.setRepoRemote({
        workspaceId: activeWorkspace.id,
        remoteUrl: remoteUrl.trim()
      })
      await loadRepoInfo(activeWorkspace.id)
      setIsEditingRemote(false)
      setRemoteSaved(true)
      setTimeout(() => setRemoteSaved(false), 2000)
    } catch (e) {
      console.error('Failed to set remote:', e)
    }
    setIsSavingRemote(false)
  }

  const handleSaveToken = async (): Promise<void> => {
    if (!activeWorkspace || !token.trim()) return
    setIsSavingToken(true)
    setTokenError(null)
    setTokenSuccess(null)
    try {
      const result = await window.api.saveGitHubToken({
        workspaceId: activeWorkspace.id,
        token: token.trim()
      })
      setTokenSuccess(`Connected as ${result.login}`)
      setToken('')
      await loadGitHubStatus(activeWorkspace.id)
    } catch (e) {
      setTokenError((e as Error).message)
    }
    setIsSavingToken(false)
  }

  const handleDisconnectGitHub = async (): Promise<void> => {
    if (!activeWorkspace) return
    await window.api.removeGitHubToken({ workspaceId: activeWorkspace.id })
    await loadGitHubStatus(activeWorkspace.id)
    setTokenSuccess(null)
  }

  const handleToggleSetting = async (key: string, value: boolean): Promise<void> => {
    if (!activeWorkspace) return
    const updated = { ...settings, [key]: value }
    setSettings(updated)
    await window.api.updateWorkspaceSettings({
      workspaceId: activeWorkspace.id,
      settings: updated
    })
  }

  if (!activeWorkspace) return <div />

  const hasRemote = localRepoInfo?.hasRemote && localRepoInfo?.remoteUrl
  const showRemoteInput = isEditingRemote || !hasRemote

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      {/* Fix #11: Page header for consistency with other settings tabs */}
      <div className="mb-2">
        <h2 className="text-base font-semibold text-text-primary">Repository & GitHub</h2>
        <p className="text-xs text-text-secondary mt-1">
          Configure git repository settings, GitHub integration, and automation rules.
        </p>
      </div>

      {/* Section 1: Repository Status */}
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
                  {activeWorkspace.repoPath}
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
                      <span className="flex items-center gap-1 text-xs text-success shrink-0">
                        <Check size={10} />
                        Saved
                      </span>
                    ) : (
                      /* Fix #3: Edit button to expand remote input */
                      <button
                        onClick={() => setIsEditingRemote(true)}
                        className="text-text-secondary hover:text-text-primary transition-colors shrink-0"
                        aria-label="Edit remote URL"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </span>
                ) : (
                  <span className="text-sm text-text-body font-mono text-text-muted">None</span>
                )}
              </div>

              {/* Fix #3: Remote URL input — only shown when editing or no remote */}
              {showRemoteInput && (
                <div className="pt-3 mt-3 border-t border-border-subtle">
                  <label className="block text-xs text-text-secondary mb-1.5">
                    {hasRemote ? 'Change remote URL' : 'Add remote URL'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://github.com/owner/repo.git"
                      className="flex-1 px-3 py-1.5 bg-surface-base border border-border-default rounded-lg text-xs text-text-body font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    />
                    {/* Fix #8: Save button with success feedback */}
                    <button
                      onClick={handleSaveRemote}
                      disabled={isSavingRemote || !remoteUrl.trim()}
                      className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
                    >
                      {isSavingRemote ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                    </button>
                    {isEditingRemote && (
                      <button
                        onClick={() => {
                          setIsEditingRemote(false)
                          if (localRepoInfo?.remoteUrl) setRemoteUrl(localRepoInfo.remoteUrl)
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">Path</span>
                <span className="text-sm text-text-body font-mono truncate max-w-[50%]">
                  {activeWorkspace.repoPath}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-xs text-warning">
                  <AlertTriangle size={12} />
                  <span>Not a git repository</span>
                </div>
                <button
                  onClick={handleInitRepo}
                  disabled={isInitializingRepo}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors"
                >
                  {isInitializingRepo ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <GitBranch size={12} />
                  )}
                  Initialize Git
                </button>
              </div>
            </div>
          )}
        </SettingsCard>
      </section>

      {/* Section 2: GitHub Connection */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
            GitHub Connection
          </h3>
          {githubStatus?.configured && (
            <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
              <Check size={10} />
              Connected
            </span>
          )}
        </div>

        <SettingsCard>
          {githubStatus?.configured ? (
            /* Fix #5: Enriched connected state with avatar and scope info */
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-success-muted flex items-center justify-center shrink-0">
                <Check size={16} className="text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-text-primary">{githubStatus.login}</span>
                <p className="text-xs text-text-secondary">Personal Access Token · repo scope</p>
              </div>
              <button
                onClick={handleDisconnectGitHub}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded-lg transition-colors shrink-0"
              >
                <X size={12} />
                Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-text-secondary">
                Connect a GitHub Personal Access Token to enable automatic PR creation.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="flex-1 px-3 py-1.5 bg-surface-base border border-border-default rounded-lg text-xs text-text-body font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
                <button
                  onClick={handleSaveToken}
                  disabled={isSavingToken || !token.trim()}
                  className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
                >
                  {isSavingToken ? <Loader2 size={12} className="animate-spin" /> : 'Connect'}
                </button>
              </div>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary-text hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.open('https://github.com/settings/tokens/new?scopes=repo', '_blank')
                }}
              >
                Generate a token with repo scope
                <ExternalLink size={10} />
              </a>
              {tokenError && (
                <p className="text-xs text-danger flex items-center gap-1">
                  <AlertTriangle size={10} />
                  {tokenError}
                </p>
              )}
              {tokenSuccess && (
                <p className="text-xs text-success flex items-center gap-1">
                  <Check size={10} />
                  {tokenSuccess}
                </p>
              )}
            </div>
          )}
        </SettingsCard>
      </section>

      {/* Section 3: Automation */}
      <section>
        {(() => {
          const activeCount = [
            settings.gitAutoBranch,
            settings.gitAutoPR,
            settings.gitAutoCleanup
          ].filter(Boolean).length
          return (
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
                Automation
              </h3>
              {activeCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
                  <Check size={10} />
                  {activeCount}/3 active
                </span>
              )}
            </div>
          )
        })()}

        {/* Fix #7: Dividers between toggle rows */}
        <SettingsCard className="divide-y divide-border-subtle">
          <div className="py-3 first:pt-0 last:pb-0">
            <ToggleRow
              label="Auto-create branches"
              description="Create a git branch for each conversation automatically"
              checked={!!settings.gitAutoBranch}
              onChange={(v) => handleToggleSetting('gitAutoBranch', v)}
            />
          </div>
          <div className="py-3 first:pt-0 last:pb-0">
            <ToggleRow
              label="Auto-create pull requests"
              description="Create a GitHub PR when completing a conversation"
              checked={!!settings.gitAutoPR}
              onChange={(v) => handleToggleSetting('gitAutoPR', v)}
            />
            {/* Fix #10: Dependency warning — requires GitHub + remote */}
            {!!settings.gitAutoPR && !githubStatus?.configured && (
              <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
                <AlertTriangle size={10} />
                Requires GitHub connection
              </p>
            )}
            {!!settings.gitAutoPR && githubStatus?.configured && !hasRemote && (
              <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
                <AlertTriangle size={10} />
                Requires a remote URL
              </p>
            )}
          </div>
          <div className="py-3 first:pt-0 last:pb-0">
            <ToggleRow
              label="Auto-cleanup branches"
              description="Delete branches after PRs are merged or closed"
              checked={!!settings.gitAutoCleanup}
              onChange={(v) => handleToggleSetting('gitAutoCleanup', v)}
            />
            {/* Fix #10: Dependency warning — requires auto-PR */}
            {!!settings.gitAutoCleanup && !settings.gitAutoPR && (
              <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
                <AlertTriangle size={10} />
                Requires auto-create pull requests to be enabled
              </p>
            )}
          </div>
        </SettingsCard>
      </section>
    </div>
  )
}

/* Fix #4: Added aria-label to toggle button */
function ToggleRow({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-text-body">{label}</p>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-surface-base border border-border-default'
        }`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  )
}

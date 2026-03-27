import { useState, useEffect } from 'react'
import { GitBranch, Check, X, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
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

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
      {/* Section 1: Repository Status */}
      <section>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Repository
        </h3>

        <SettingsCard className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Path</span>
            <span className="text-sm text-text-body font-mono truncate max-w-[60%] text-right">
              {activeWorkspace.repoPath}
            </span>
          </div>

          {localRepoInfo?.isRepo ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Status</span>
                <span className="flex items-center gap-1.5 text-xs text-success">
                  <Check size={12} />
                  Git repository
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Branch</span>
                <span className="text-sm text-text-body font-mono">
                  {localRepoInfo.currentBranch}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">Remote:</span>
                <span className="text-sm text-text-body font-mono truncate max-w-[60%] text-right">
                  {localRepoInfo.remoteUrl || 'None'}
                </span>
              </div>

              {/* Remote URL input */}
              <div className="pt-2 border-t border-border-subtle">
                <label className="block text-xs text-text-secondary mb-1.5">
                  {localRepoInfo.hasRemote ? 'Change remote URL' : 'Add remote URL'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo.git"
                    className="flex-1 px-3 py-1.5 bg-surface-base border border-border-default rounded-lg text-xs text-text-body font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                  <button
                    onClick={handleSaveRemote}
                    disabled={isSavingRemote || !remoteUrl.trim()}
                    className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors"
                  >
                    {isSavingRemote ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between">
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
          )}
        </SettingsCard>
      </section>

      {/* Section 2: GitHub Connection */}
      <section>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          GitHub Connection
        </h3>

        <SettingsCard className="space-y-3">
          {githubStatus?.configured ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Check size={14} className="text-success" />
                <span className="text-sm text-text-body">
                  Connected as <strong className="text-text-primary">{githubStatus.login}</strong>
                </span>
              </div>
              <button
                onClick={handleDisconnectGitHub}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded-lg transition-colors"
              >
                <X size={12} />
                Disconnect
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}
        </SettingsCard>
      </section>

      {/* Section 3: Automation */}
      <section>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Automation
        </h3>

        <SettingsCard className="space-y-4">
          <ToggleRow
            label="Auto-create branches"
            description="Create a git branch for each conversation automatically"
            checked={!!settings.gitAutoBranch}
            onChange={(v) => handleToggleSetting('gitAutoBranch', v)}
          />
          <ToggleRow
            label="Auto-create pull requests"
            description="Create a GitHub PR when completing a conversation"
            checked={!!settings.gitAutoPR}
            onChange={(v) => handleToggleSetting('gitAutoPR', v)}
          />
          <ToggleRow
            label="Auto-cleanup branches"
            description="Delete branches after PRs are merged or closed"
            checked={!!settings.gitAutoCleanup}
            onChange={(v) => handleToggleSetting('gitAutoCleanup', v)}
          />
        </SettingsCard>
      </section>
    </div>
  )
}

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

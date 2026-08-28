import { useState, useEffect } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import type { RepoInfo } from '../../../../shared/types'
import {
  GitConfigSection,
  GitHubTokenSection,
  AutomationSection,
  LeadReviewSection
} from './settings-sections'

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
      window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id }).then((s) => {
        setSettings(s)
      })
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
    } catch (err) {
      console.error('Failed to init repo:', err)
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
      setTimeout(() => setRemoteSaved(false), 3000)
    } catch (err) {
      console.error('Failed to set remote:', err)
    }
    setIsSavingRemote(false)
  }

  const handleSaveToken = async (): Promise<void> => {
    if (!activeWorkspace) return
    setIsSavingToken(true)
    setTokenError(null)
    setTokenSuccess(null)
    try {
      await window.api.saveGitHubToken({
        workspaceId: activeWorkspace.id,
        token: token.trim()
      })
      await loadGitHubStatus(activeWorkspace.id)
      setTokenSuccess('GitHub connected successfully')
      setToken('')
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to save token')
    }
    setIsSavingToken(false)
  }

  const handleDisconnectGitHub = async (): Promise<void> => {
    if (!activeWorkspace) return
    try {
      await window.api.removeGitHubToken({ workspaceId: activeWorkspace.id })
      await loadGitHubStatus(activeWorkspace.id)
    } catch (err) {
      console.error('Failed to disconnect GitHub:', err)
    }
  }

  const handleToggleSetting = async (key: string, value: boolean): Promise<void> => {
    if (!activeWorkspace) return
    setSettings((prev) => ({ ...prev, [key]: value }))
    // Send ONLY the changed key — main merges over the stored settings, so
    // posting this page's snapshot would revert keys other pages have written.
    await window.api.updateWorkspaceSettings({
      workspaceId: activeWorkspace.id,
      settings: { [key]: value }
    })
  }

  if (!activeWorkspace) return <div />

  const hasRemote = !!(localRepoInfo?.hasRemote && localRepoInfo?.remoteUrl)

  return (
    <div data-testid="repository-settings" className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      {/* Fix #11: Page header for consistency with other settings tabs */}
      <div className="mb-2">
        <h2 className="text-base font-semibold text-text-primary">Repository & GitHub</h2>
        <p className="text-xs text-text-secondary mt-1">
          Configure git repository settings, GitHub integration, and automation rules.
        </p>
      </div>

      <GitConfigSection
        activeWorkspacePath={activeWorkspace.repoPath}
        localRepoInfo={localRepoInfo}
        remoteUrl={remoteUrl}
        isEditingRemote={isEditingRemote}
        remoteSaved={remoteSaved}
        isSavingRemote={isSavingRemote}
        isInitializingRepo={isInitializingRepo}
        onRemoteUrlChange={setRemoteUrl}
        onEditRemote={() => setIsEditingRemote(true)}
        onCancelEditRemote={() => setIsEditingRemote(false)}
        onSaveRemote={handleSaveRemote}
        onInitRepo={handleInitRepo}
      />

      <GitHubTokenSection
        configured={!!githubStatus?.configured}
        login={githubStatus?.login}
        tokenType={githubStatus?.tokenType}
        token={token}
        isSavingToken={isSavingToken}
        tokenError={tokenError}
        tokenSuccess={tokenSuccess}
        onTokenChange={setToken}
        onSaveToken={handleSaveToken}
        onDisconnect={handleDisconnectGitHub}
      />

      <AutomationSection
        settings={settings}
        githubConfigured={!!githubStatus?.configured}
        hasRemote={hasRemote}
        onToggle={handleToggleSetting}
      />

      {/* M6.1 — post-verify lead-review pass toggle */}
      <LeadReviewSection
        enabled={settings.leadReviewPass === true}
        onToggle={(v) => void handleToggleSetting('leadReviewPass', v)}
      />
    </div>
  )
}

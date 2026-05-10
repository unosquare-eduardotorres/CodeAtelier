import { useState, useCallback } from 'react'
import { AlertTriangle, Info, X, ExternalLink } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'

interface RepoWarningBannerProps {
  onNavigateToSettings?: () => void
}

export default function RepoWarningBanner({
  onNavigateToSettings
}: RepoWarningBannerProps): React.JSX.Element | null {
  const { repoInfo, githubStatus, activeWorkspace } = useWorkspaceStore()

  // Persistent dismiss — keyed per workspace so re-opening a workspace with changed
  // git config can show the banner again. Falls back to session-level dismiss if
  // no workspace is active.
  const dismissKey = activeWorkspace
    ? `repo-warning-dismissed-${activeWorkspace.id}`
    : 'repo-warning-dismissed'

  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissKey) === '1'
    } catch {
      return false
    }
  })

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(dismissKey, '1')
    } catch {
      // Best effort
    }
  }, [dismissKey])

  if (dismissed) return null

  // No repo configured
  if (!repoInfo?.isRepo) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-warning-muted border-b border-warning/20">
        <AlertTriangle size={14} className="text-warning flex-shrink-0" />
        <span className="text-xs text-warning flex-1">
          Set up a repository to track your code changes
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs font-medium text-warning hover:brightness-110 transition-colors px-2 py-0.5 rounded bg-warning/10 hover:bg-warning/20"
          >
            <ExternalLink size={11} />
            Set up now
          </button>
        )}
        <button
          onClick={handleDismiss}
          className="p-0.5 text-warning/60 hover:text-warning transition-colors"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  // Repo but no GitHub
  if (!githubStatus?.configured) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-info-muted border-b border-info/20">
        <Info size={14} className="text-info flex-shrink-0" />
        <span className="text-xs text-info flex-1">
          Connect GitHub to enable pull requests
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs font-medium text-info hover:brightness-110 transition-colors px-2 py-0.5 rounded bg-info/10 hover:bg-info/20"
          >
            <ExternalLink size={11} />
            Connect
          </button>
        )}
        <button
          onClick={handleDismiss}
          className="p-0.5 text-info/60 hover:text-info transition-colors"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  // Fully configured — no banner
  return null
}

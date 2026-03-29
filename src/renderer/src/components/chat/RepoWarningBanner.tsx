import { useState } from 'react'
import { AlertTriangle, Info, X, Settings } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'

interface RepoWarningBannerProps {
  onNavigateToSettings?: () => void
}

export default function RepoWarningBanner({
  onNavigateToSettings
}: RepoWarningBannerProps): React.JSX.Element | null {
  const { repoInfo, githubStatus } = useWorkspaceStore()
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  // No repo configured
  if (!repoInfo?.isRepo) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-warning-muted border-b border-warning/20">
        <AlertTriangle size={14} className="text-warning flex-shrink-0" />
        <span className="text-xs text-warning flex-1">
          No git repository configured. Git features (branches, commits, PRs) are disabled.
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs text-warning hover:brightness-110 transition-colors"
          >
            <Settings size={12} />
            Configure
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
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
          GitHub not connected. Automatic PR creation is disabled.
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs text-info hover:brightness-110 transition-colors"
          >
            <Settings size={12} />
            Connect
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
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

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
      <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
        <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
        <span className="text-xs text-amber-300 flex-1">
          No git repository configured. Git features (branches, commits, PRs) are disabled.
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
          >
            <Settings size={12} />
            Configure
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="p-0.5 text-amber-400/60 hover:text-amber-400 transition-colors"
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
      <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20">
        <Info size={14} className="text-blue-400 flex-shrink-0" />
        <span className="text-xs text-blue-300 flex-1">
          GitHub not connected. Automatic PR creation is disabled.
        </span>
        {onNavigateToSettings && (
          <button
            onClick={onNavigateToSettings}
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Settings size={12} />
            Connect
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="p-0.5 text-blue-400/60 hover:text-blue-400 transition-colors"
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

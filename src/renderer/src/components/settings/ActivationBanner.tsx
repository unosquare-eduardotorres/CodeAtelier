import { Sparkles, Loader2, AlertCircle, RotateCcw } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'

interface ActivationBannerProps {
  workspacePath: string
}

export default function ActivationBanner({
  workspacePath
}: ActivationBannerProps): React.JSX.Element {
  const { isActivating, activationError, deployAll } = useSettingsStore()

  const handleActivate = (): void => {
    deployAll(workspacePath)
  }

  return (
    <div className="rounded border border-primary/30 bg-primary-muted p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary-muted flex items-center justify-center">
          <Sparkles size={20} className="text-primary-text" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">Activate Agents for Workspace</h3>
          <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
            No specialists are active for this workspace yet. Click below to auto-activate agents
            relevant to your project.
          </p>

          <div className="mt-3 space-y-1">
            <p className="text-xs text-text-muted">This will:</p>
            <ul className="text-xs text-text-muted space-y-0.5 ml-4 list-disc">
              <li>Analyze your project&apos;s tech stack</li>
              <li>Activate relevant specialist agents</li>
              <li>
                Generate <code className="text-text-secondary">CLAUDE.md</code> configuration
              </li>
            </ul>
          </div>

          {/* Error display */}
          {activationError && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-danger-muted border border-danger/20">
              <AlertCircle size={14} className="text-danger flex-shrink-0" />
              <span className="text-xs text-danger flex-1">{activationError}</span>
              <button
                onClick={handleActivate}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-danger-muted text-danger hover:bg-danger/30 transition-colors flex-shrink-0"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            </div>
          )}

          {/* Button area */}
          <div className="mt-4">
            <button
              onClick={handleActivate}
              disabled={isActivating}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isActivating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Activating...
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  Auto-Activate Agents
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

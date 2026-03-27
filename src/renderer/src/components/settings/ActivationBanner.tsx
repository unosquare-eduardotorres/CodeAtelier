import { Rocket, Loader2, AlertCircle, RotateCcw } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'

interface ActivationBannerProps {
  workspacePath: string
}

export default function ActivationBanner({
  workspacePath
}: ActivationBannerProps): React.JSX.Element {
  const { isActivating, activationError, deployAll } = useSettingsStore()

  const handleDeploy = (): void => {
    deployAll(workspacePath)
  }

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center">
          <Rocket size={20} className="text-indigo-400" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-100">Deploy Agents to Workspace</h3>
          <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
            No specialists are deployed to this workspace yet. Click below to copy the full preset
            of agents and skills. They will start inactive — activate each one individually.
          </p>

          <div className="mt-3 space-y-1">
            <p className="text-xs text-gray-500">This will:</p>
            <ul className="text-xs text-gray-500 space-y-0.5 ml-4 list-disc">
              <li>
                Create <code className="text-gray-400">.claude/agents/</code> and{' '}
                <code className="text-gray-400">.claude/skills/</code> directories
              </li>
              <li>Copy all specialist agent YAMLs and skill files</li>
              <li>Create database records for each agent and skill (all inactive)</li>
            </ul>
          </div>

          {/* Error display */}
          {activationError && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
              <span className="text-xs text-red-400 flex-1">{activationError}</span>
              <button
                onClick={handleDeploy}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex-shrink-0"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            </div>
          )}

          {/* Button area */}
          <div className="mt-4">
            <button
              onClick={handleDeploy}
              disabled={isActivating}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isActivating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  Deploy Agents &amp; Skills
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

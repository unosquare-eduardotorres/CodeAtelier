import { useEffect, useRef } from 'react'
import { Rocket, Loader2, AlertCircle, RotateCcw, CheckCircle2, FileText, XCircle } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'

interface ActivationBannerProps {
  workspacePath: string
}

export default function ActivationBanner({
  workspacePath
}: ActivationBannerProps): React.JSX.Element {
  const {
    isActivating,
    activationError,
    activateWorkspace,
    pendingClaudeMd,
    activationLog,
    cancelActivation
  } = useSettingsStore()

  const logEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activationLog])

  const handleActivate = (): void => {
    activateWorkspace(workspacePath)
  }

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center">
          <Rocket size={20} className="text-indigo-400" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-100">
            Set up AI Agents for this workspace
          </h3>
          <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
            Agent Studio will analyze your project and configure the right specialist agents and
            skills for it.
          </p>

          <div className="mt-3 space-y-1">
            <p className="text-xs text-gray-500">This will:</p>
            <ul className="text-xs text-gray-500 space-y-0.5 ml-4 list-disc">
              <li>
                Create <code className="text-gray-400">.claude/agents/</code> and{' '}
                <code className="text-gray-400">.claude/skills/</code> directories
              </li>
              <li>Select the most relevant specialists for your project</li>
              <li>Merge agent/skill references into your CLAUDE.md</li>
              <li>Enable all skills for activated specialists</li>
            </ul>
          </div>

          {/* Error display */}
          {activationError && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
              <span className="text-xs text-red-400 flex-1">{activationError}</span>
              <button
                onClick={handleActivate}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex-shrink-0"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            </div>
          )}

          {/* Pending CLAUDE.md review */}
          {pendingClaudeMd && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />
              <span className="text-xs text-emerald-400 flex-1">
                Agents &amp; skills deployed. Review CLAUDE.md changes below.
              </span>
              <FileText size={14} className="text-emerald-400 flex-shrink-0" />
            </div>
          )}

          {/* Live progress console — shown while activating */}
          {isActivating && activationLog.length > 0 && (
            <div className="mt-3 rounded-lg bg-gray-950 border border-gray-800 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
                <span className="text-[11px] text-gray-500 font-mono">Activation Progress</span>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[10px] text-gray-600">live</span>
                </div>
              </div>
              <div className="max-h-40 overflow-y-auto p-2 font-mono text-[11px] space-y-0.5">
                {activationLog.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('[error]')
                        ? 'text-red-400'
                        : line.startsWith('[stderr]')
                          ? 'text-yellow-400/70'
                          : 'text-gray-500'
                    }
                  >
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* Button area */}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleActivate}
              disabled={isActivating}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isActivating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Activating...
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  Activate Agents &amp; Skills
                </>
              )}
            </button>

            {/* Cancel button — shown while activating */}
            {isActivating && (
              <button
                onClick={() => cancelActivation()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-700 text-gray-400 text-sm hover:bg-gray-800 hover:text-gray-300 transition-colors"
              >
                <XCircle size={14} />
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

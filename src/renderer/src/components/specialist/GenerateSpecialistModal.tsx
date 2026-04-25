/**
 * GenerateSpecialistModal — first-time prompt that surfaces when a workspace
 * opens with a Project Specialist still in `pending` (or `failed`) build state.
 *
 * Drives the build through `useProjectSpecialistStore.build(workspaceId)` and
 * subscribes to `buildProgress[specialistId]` for live phase/message updates.
 *
 * Lifecycle:
 *   - idle / failed → user can Generate or dismiss (Maybe later / Dismiss)
 *   - building      → spinner + progress message, footer disabled
 *   - ready         → success state, auto-closes after 1.5s
 *
 * Dismissal is session-only and tracked in the parent (ChatPanel).
 */
import { useEffect, useMemo } from 'react'
import { Sparkles, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

interface Props {
  open: boolean
  workspaceId: string
  workspaceName: string
  onDismiss: () => void
}

type ViewState = 'idle' | 'building' | 'ready' | 'failed'

export default function GenerateSpecialistModal({
  open,
  workspaceId,
  workspaceName,
  onDismiss
}: Props): React.JSX.Element | null {
  const specialist = useProjectSpecialistStore((s) => s.byWorkspace[workspaceId])
  const progress = useProjectSpecialistStore((s) =>
    specialist?.id ? s.buildProgress[specialist.id] : null
  )
  const build = useProjectSpecialistStore((s) => s.build)
  const error = useProjectSpecialistStore((s) => s.error)
  const clearError = useProjectSpecialistStore((s) => s.clearError)

  const view: ViewState = useMemo(() => {
    if (!specialist) return 'idle'
    if (specialist.buildStatus === 'building') return 'building'
    if (specialist.buildStatus === 'ready') return 'ready'
    if (specialist.buildStatus === 'failed') return 'failed'
    return 'idle' // pending
  }, [specialist])

  // Auto-close 1.5s after success
  useEffect(() => {
    if (view !== 'ready') return
    const t = setTimeout(onDismiss, 1500)
    return () => clearTimeout(t)
  }, [view, onDismiss])

  if (!open) return null

  async function handleGenerate(): Promise<void> {
    clearError()
    try {
      await build(workspaceId)
      // store.build resolves on success; auto-close handled by useEffect.
    } catch {
      // store sets `error`; view flips to 'failed' via buildStatus.
    }
  }

  const isBuilding = view === 'building'
  const isReady = view === 'ready'
  const isFailed = view === 'failed'
  const closeDisabled = isBuilding

  const techCount = specialist?.detectedTechs?.length ?? 0
  const techPlural = techCount === 1 ? '' : 's'

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(15,21,23,0.85)] backdrop-blur-md"
      role="presentation"
    >
      <div
        className="relative w-full max-w-md mx-4 bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-label="Generate Project Specialist"
      >
        {/* Close (X) — disabled while building */}
        <button
          type="button"
          onClick={onDismiss}
          disabled={closeDisabled}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-md text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X size={16} />
        </button>

        {/* Header */}
        <div className="px-8 pt-8 pb-2 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/15 mb-4">
            {isReady ? (
              <CheckCircle2 size={32} className="text-emerald-500" />
            ) : isFailed ? (
              <AlertTriangle size={32} className="text-rose-500" />
            ) : (
              <Sparkles size={32} className="text-primary-text" />
            )}
          </div>
          <h1 className="text-xl font-bold text-text-primary">
            {isReady
              ? 'Specialist Ready'
              : isFailed
                ? 'Build Failed'
                : isBuilding
                  ? 'Generating Specialist…'
                  : 'Generate Project Specialist'}
          </h1>
          <p className="text-sm text-text-secondary mt-1.5">
            {isReady
              ? `Ready — ${techCount} tech${techPlural} detected`
              : isFailed
                ? 'We couldn’t finish building your specialist'
                : isBuilding
                  ? (progress?.message ?? 'Building specialist for this project…')
                  : `Tailored for ${workspaceName}`}
          </p>
        </div>

        {/* Body */}
        <div className="px-8 pb-4 pt-3" aria-live="polite">
          {view === 'idle' && (
            <div className="bg-surface-base rounded-xl p-4 border border-border-subtle">
              <p className="text-sm text-text-body leading-relaxed">
                Agent Studio scans <span className="font-semibold">{workspaceName}</span> to detect
                its tech stack, then asks Claude to tailor a senior engineer persona for this
                project.
              </p>
              <p className="text-xs text-text-muted mt-2">Takes about 30-60 seconds.</p>
            </div>
          )}

          {view === 'building' && (
            <div className="bg-surface-base rounded-xl p-4 border border-border-subtle flex items-center gap-3">
              <Loader2 size={20} className="text-primary-text animate-spin flex-shrink-0" />
              <div className="text-sm text-text-body">
                {progress?.message ?? 'Building specialist for this project…'}
              </div>
            </div>
          )}

          {view === 'failed' && (
            <div className="space-y-3">
              <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/20 text-sm text-danger">
                {error ?? progress?.message ?? 'Build failed'}
              </div>
              {techCount > 0 && (
                <div className="bg-surface-base rounded-xl p-3 border border-border-subtle">
                  <p className="text-[11px] text-text-muted mb-1.5 uppercase tracking-wider font-medium">
                    Detected ({techCount})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {specialist?.detectedTechs?.map((tech) => (
                      <span
                        key={tech}
                        className="px-2 py-0.5 rounded-md bg-surface-overlay text-xs text-text-body"
                      >
                        {tech}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === 'ready' && (
            <div className="bg-surface-base rounded-xl p-4 border border-border-subtle text-center">
              <p className="text-sm text-text-body">
                Your specialist is ready — closing automatically.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {!isReady && (
          <div className="px-8 pb-8 pt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={onDismiss}
              disabled={isBuilding}
              className="flex-1 h-12 rounded-xl text-sm font-semibold bg-surface-overlay text-text-body hover:bg-surface-overlay/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
            >
              {isFailed ? 'Dismiss' : 'Maybe later'}
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isBuilding}
              className="flex-1 h-12 rounded-xl text-sm font-semibold bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
            >
              {isBuilding ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Building…
                </>
              ) : isFailed ? (
                'Retry'
              ) : (
                'Generate Now'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

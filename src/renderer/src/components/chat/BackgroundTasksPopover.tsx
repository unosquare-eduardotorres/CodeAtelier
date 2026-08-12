import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, X, Square, BellOff, Loader2 } from 'lucide-react'
import type { BackgroundProcessInfo } from '../../../../shared/types'
import { formatDuration } from '../../../../shared/format-duration'

interface BackgroundTasksPopoverProps {
  onClose: () => void
}

/**
 * Row identity: two workspaces can share a repoPath, and then the same PID is
 * listed twice — the PID alone is not unique.
 */
function rowKey(proc: BackgroundProcessInfo): string {
  return `${proc.workspaceId}:${proc.pid}`
}

/**
 * Lists the detached processes the agent spawned via `run_background`, with a
 * Stop button for each.
 *
 * These processes survive both the agent turn and the app itself, and until
 * now `stop_process` was agent-only — so a runaway build had no user-facing
 * off switch anywhere.
 */
export default function BackgroundTasksPopover({
  onClose
}: BackgroundTasksPopoverProps): React.JSX.Element {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** Per-row explanation for an action that did nothing (e.g. "no longer tracked"). */
  const [notices, setNotices] = useState<Record<string, string>>({})
  const popoverRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setProcesses(await window.api.processList())
    } catch (error) {
      console.error('Failed to list background processes:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Uptime ticks and liveness changes both need a periodic re-read
    const initial = setTimeout(() => void refresh(), 0)
    const interval = setInterval(() => void refresh(), 3000)
    const unsubscribe = window.api.onProcessChanged(() => void refresh())
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
      unsubscribe()
    }
  }, [refresh])

  // Close on outside click. `click` (not `mousedown`) so the trigger button's
  // own toggle has already run — both then agree on "closed" instead of the
  // close-then-reopen flicker mousedown would cause.
  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [onClose])

  const handleStop = async (proc: BackgroundProcessInfo): Promise<void> => {
    const key = rowKey(proc)
    setBusyKey(key)
    try {
      const result = await window.api.processStop({ pid: proc.pid })
      if (result.reason === 'untracked') {
        setNotices((prev) => ({ ...prev, [key]: 'no longer tracked — nothing was stopped' }))
      }
      await refresh()
    } catch (error) {
      console.error('Failed to stop background process:', error)
    } finally {
      setBusyKey(null)
    }
  }

  const handleCancelWatch = async (proc: BackgroundProcessInfo): Promise<void> => {
    const key = rowKey(proc)
    try {
      const result = await window.api.processCancelWatch({ pid: proc.pid })
      if (result.reason === 'untracked') {
        setNotices((prev) => ({ ...prev, [key]: 'no longer tracked' }))
      }
      await refresh()
    } catch (error) {
      console.error('Failed to cancel auto-resume:', error)
    }
  }

  return (
    <div
      ref={popoverRef}
      data-testid="background-tasks-popover"
      className="absolute bottom-full mb-2 left-0 w-96 bg-surface-float rounded-xl border border-border-subtle shadow-xl z-50 overflow-hidden"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-surface-overlay border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">Background tasks</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-surface-base text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="max-h-72 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-text-muted">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : processes.length === 0 ? (
          <p className="px-4 py-8 text-xs text-text-muted text-center leading-relaxed">
            No background tasks running.
            <br />
            Commands the agent starts with <code>run_background</code> appear here.
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {processes.map((proc) => (
              <li key={rowKey(proc)} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        proc.alive ? 'bg-success' : 'bg-text-muted'
                      }`}
                      aria-hidden
                    />
                    <span className="text-sm text-text-primary truncate" title={proc.command}>
                      {proc.label}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    pid {proc.pid} · {proc.alive ? formatDuration(proc.uptimeMs) : 'exited'}
                    {proc.watched && ' · will notify on exit'}
                    {notices[rowKey(proc)] && ` · ${notices[rowKey(proc)]}`}
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {proc.watched && (
                    <button
                      onClick={() => void handleCancelWatch(proc)}
                      className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
                      aria-label={`Cancel auto-resume for pid ${proc.pid}`}
                      title="Cancel auto-resume"
                    >
                      <BellOff size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => void handleStop(proc)}
                    disabled={busyKey === rowKey(proc)}
                    className="p-1.5 rounded-md text-danger hover:bg-danger-muted disabled:opacity-40 transition-colors"
                    aria-label={`Stop pid ${proc.pid}`}
                    title="Stop process"
                  >
                    {busyKey === rowKey(proc) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Square size={14} />
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-border-subtle">
        <p className="text-[11px] text-text-muted leading-relaxed">
          These processes are detached and keep running if you quit the app.
        </p>
      </div>
    </div>
  )
}

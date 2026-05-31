import { Zap } from 'lucide-react'
import { useHookLifecycleStore } from '@renderer/store/hook-lifecycle.store'

/**
 * Minimal hook execution indicator — shows active hooks inline during streaming.
 * Renders nothing when no hooks are running.
 */
export default function HookActivityIndicator(): React.JSX.Element | null {
  const activeHooks = useHookLifecycleStore((s) => s.activeHooks)

  if (activeHooks.size === 0) return null

  const hookNames = Array.from(activeHooks.values()).map((h) => h.hookName)
  const label = hookNames.length === 1 ? hookNames[0] : `${hookNames.length} hooks`

  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-text-muted rounded-md bg-surface-overlay/40 border border-border-subtle animate-pulse">
      <Zap size={10} className="text-yellow-400" />
      <span>
        Running: <span className="font-medium text-text-secondary">{label}</span>
      </span>
    </div>
  )
}

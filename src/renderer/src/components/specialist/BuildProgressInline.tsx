/**
 * BuildProgressInline — inline progress strip shown in the chat header while
 * a Project Specialist is being built / rebuilt.
 *
 * Reads latest event from projectSpecialistStore.buildProgress and renders a
 * small spinner + phase message. Auto-hides on 'ready' after 2s.
 */
import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

interface BuildProgressInlineProps {
  specialistId: string | null
}

export default function BuildProgressInline({
  specialistId
}: BuildProgressInlineProps): React.JSX.Element | null {
  const event = useProjectSpecialistStore((s) =>
    specialistId ? s.buildProgress[specialistId] : null
  )
  const [visible, setVisible] = useState<boolean>(false)

  useEffect(() => {
    if (!event) {
      setVisible(false)
      return
    }
    setVisible(true)
    if (event.phase === 'ready') {
      const t = setTimeout(() => setVisible(false), 2_000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [event])

  if (!event || !visible) return null

  const Icon = event.phase === 'ready' ? CheckCircle2 : event.phase === 'failed' ? XCircle : Loader2
  const iconClass =
    event.phase === 'ready'
      ? 'text-emerald-500'
      : event.phase === 'failed'
        ? 'text-rose-500'
        : 'text-blue-500 animate-spin'

  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
      <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
      <span>{event.message}</span>
    </div>
  )
}

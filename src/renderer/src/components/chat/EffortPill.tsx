import { Zap, Settings, Brain, Flame, Rocket } from 'lucide-react'
import type { ThinkingEffort } from '../../../../shared/types'

const EFFORT_CONFIG = {
  low: {
    icon: Zap,
    label: 'Low',
    tintClass: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/25',
    title: 'Quick answers, minimal deliberation'
  },
  medium: {
    icon: Settings,
    label: 'Medium',
    tintClass:
      'bg-surface-overlay/80 text-text-secondary border-border-subtle hover:bg-surface-overlay',
    title: 'Balanced reasoning depth (default)'
  },
  high: {
    icon: Brain,
    label: 'High',
    tintClass: 'bg-purple-500/15 text-purple-400 border-purple-500/40 hover:bg-purple-500/25',
    title: 'Deep reasoning chains'
  },
  xhigh: {
    icon: Flame,
    label: 'X-High',
    tintClass: 'bg-orange-500/15 text-orange-400 border-orange-500/40 hover:bg-orange-500/25',
    title: 'Extended reasoning — slower, more thorough'
  },
  max: {
    icon: Rocket,
    label: 'Max',
    tintClass: 'bg-red-500/15 text-red-400 border-red-500/40 hover:bg-red-500/25',
    title: 'Maximum thinking budget — deepest reasoning'
  }
} as const

const CYCLE_ORDER: ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface EffortPillProps {
  effort: ThinkingEffort
  onChange: (effort: ThinkingEffort) => void
  disabled?: boolean
}

export default function EffortPill({
  effort,
  onChange,
  disabled
}: EffortPillProps): React.JSX.Element {
  const config = EFFORT_CONFIG[effort]
  const Icon = config.icon

  const handleClick = (): void => {
    if (disabled) return
    const currentIndex = CYCLE_ORDER.indexOf(effort)
    const nextEffort = CYCLE_ORDER[(currentIndex + 1) % CYCLE_ORDER.length]
    onChange(nextEffort)
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`pointer-events-auto inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-semibold border-2 shadow-lg backdrop-blur-sm transition-all cursor-pointer hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 ${config.tintClass}`}
      title={config.title}
    >
      <Icon size={14} />
      {config.label}
    </button>
  )
}

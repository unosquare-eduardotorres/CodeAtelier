import {
  FileCode,
  Eye,
  Bug,
  Layers,
  Cloud,
  Smartphone,
  Shield,
  Zap,
  Puzzle,
  Info
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'

// ── Icon lookup for dynamic use-case icons ──
const ICON_MAP: Record<string, LucideIcon> = {
  FileCode,
  Eye,
  Bug,
  Layers,
  Cloud,
  Smartphone,
  Shield,
  Zap,
  Puzzle,
  Info
}

function DynamicIcon({
  name,
  size = 14,
  className
}: {
  name: string
  size?: number
  className?: string
}): React.JSX.Element {
  const Icon = ICON_MAP[name] ?? Puzzle
  return <Icon size={size} className={className} />
}

export default function UseCaseGrid({
  useCases
}: {
  useCases: NonNullable<ExternalMcpDefinition['useCases']>
}): React.JSX.Element {
  return (
    <div data-testid="use-case-grid" className="space-y-2">
      <h5 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
        What can your agent do?
      </h5>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {useCases.map((uc) => (
          <div
            key={uc.title}
            className="bg-surface-base rounded-md border border-border-subtle p-3 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded flex items-center justify-center bg-accent/10">
                <DynamicIcon name={uc.icon} size={12} className="text-accent" />
              </div>
              <span className="text-xs font-semibold text-text-primary">{uc.title}</span>
            </div>
            <p className="text-[11px] text-text-secondary leading-relaxed">{uc.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

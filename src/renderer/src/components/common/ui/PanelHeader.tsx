import type { ReactNode } from 'react'

interface PanelHeaderProps {
  title: string
  description?: ReactNode
  icon?: ReactNode
  /** Right-aligned action zone. */
  actions?: ReactNode
  className?: string
}

/** Title / description / actions row shared by every ingestion section. */
export default function PanelHeader({
  title,
  description,
  icon,
  actions,
  className = ''
}: PanelHeaderProps): React.JSX.Element {
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {icon}
          {title}
        </h3>
        {description && (
          <p className="text-xs text-text-secondary mt-0.5 max-w-prose">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

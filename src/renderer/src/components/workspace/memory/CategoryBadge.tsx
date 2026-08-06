import { useState } from 'react'

import type { MemoryFactCategory } from '../../../../../shared/types'

// ── Category metadata ──

const CATEGORY_META: Record<
  MemoryFactCategory,
  { label: string; color: string; description: string; example: string }
> = {
  decision: {
    label: 'Decision',
    color: 'bg-info-muted text-info',
    description: 'Architectural or technology choices',
    example: '"Chose PostgreSQL over MongoDB for ACID compliance"'
  },
  convention: {
    label: 'Convention',
    color: 'bg-success-muted text-success',
    description: 'Patterns the codebase follows',
    example: '"All API endpoints follow REST naming conventions"'
  },
  gotcha: {
    label: 'Gotcha',
    color: 'bg-mode-build-muted text-mode-build-text',
    description: 'Traps and non-obvious constraints',
    example: '"Test DB must be reset before integration tests"'
  },
  preference: {
    label: 'Preference',
    color: 'bg-mode-plan-muted text-mode-plan-text',
    description: 'How you like things done',
    example: '"Prefer concise code over verbose comments"'
  },
  reference: {
    label: 'Reference',
    color: 'bg-surface-float text-text-secondary border border-border-subtle',
    description: 'Pointers to docs and files',
    example: '"Auth flow documented in docs/auth-architecture.md"'
  }
}

// ── Component ──

interface CategoryBadgeProps {
  category: MemoryFactCategory
}

export default function CategoryBadge({ category }: CategoryBadgeProps): React.JSX.Element {
  const [showTooltip, setShowTooltip] = useState(false)
  const meta = CATEGORY_META[category]

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className={`px-1.5 py-0.5 text-xs rounded ${meta.color}`}>{meta.label}</span>

      {showTooltip && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-56 px-3 py-2 text-xs bg-surface-float border border-border-default rounded-md shadow-lg text-text-secondary pointer-events-none">
          <p className="font-medium text-text-primary mb-1">{meta.label}</p>
          <p>{meta.description}</p>
          <p className="mt-1 text-text-muted italic">{meta.example}</p>
        </div>
      )}
    </div>
  )
}

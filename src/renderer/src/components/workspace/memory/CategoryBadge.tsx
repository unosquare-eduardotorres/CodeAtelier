import { useState } from 'react'

import { CATEGORY_META } from './category-meta'
import type { MemoryFactCategory } from '../../../../../shared/types'

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

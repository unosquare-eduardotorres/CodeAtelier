import { useState } from 'react'

import type { MemoryFactTier } from '../../../../../shared/types'

// ── Tier metadata ──

const TIER_META: Record<
  MemoryFactTier,
  { label: string; name: string; color: string; nextHint: string }
> = {
  0: {
    label: 'T0',
    name: 'Observed',
    color: 'text-text-muted',
    nextHint: '2 confirmations promote to T1 Confirmed.'
  },
  1: {
    label: 'T1',
    name: 'Confirmed',
    color: 'text-info',
    nextHint: '3 total confirmations promote to T2 Established.'
  },
  2: {
    label: 'T2',
    name: 'Established',
    color: 'text-success',
    nextHint: '5 total confirmations promote to T3 Wisdom.'
  },
  3: {
    label: 'T3',
    name: 'Wisdom',
    color: 'text-primary-text',
    nextHint: 'Maximum tier — this fact is deeply established.'
  }
}

const DOT_COLORS: Record<MemoryFactTier, string> = {
  0: 'bg-text-muted',
  1: 'bg-info',
  2: 'bg-success',
  3: 'bg-primary-text'
}

const DOT_UNFILLED = 'bg-border-default'

// ── Component ──

interface TierBadgeProps {
  tier: MemoryFactTier
  confidence: number // 0.0 – 1.0
}

export default function TierBadge({ tier, confidence }: TierBadgeProps): React.JSX.Element {
  const [showTooltip, setShowTooltip] = useState(false)
  const meta = TIER_META[tier]
  const tierIdx = Math.min(tier, 3) as MemoryFactTier

  return (
    <div
      className="relative inline-flex items-center gap-1.5"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Progress dots */}
      <div className="flex items-center gap-0.5">
        {([0, 1, 2, 3] as const).map((dotIdx) => (
          <span
            key={dotIdx}
            className={`w-1.5 h-1.5 rounded-full ${
              dotIdx <= tierIdx ? DOT_COLORS[tierIdx] : DOT_UNFILLED
            }`}
          />
        ))}
      </div>

      {/* Tier label */}
      <span className={`text-xs font-mono ${meta.color}`}>
        {meta.label} · {meta.name}
      </span>

      {/* Confidence bar */}
      <div className="w-8 h-1 bg-border-default rounded-full overflow-hidden" title={`${(confidence * 100).toFixed(0)}% confidence`}>
        <div
          className={`h-full rounded-full ${DOT_COLORS[tierIdx]}`}
          style={{ width: `${Math.round(confidence * 100)}%` }}
        />
      </div>

      {/* Tooltip */}
      {showTooltip && (
        <div className="absolute bottom-full left-0 mb-2 z-50 w-56 px-3 py-2 text-xs bg-surface-float border border-border-default rounded-md shadow-lg text-text-secondary pointer-events-none">
          <p className="font-medium text-text-primary mb-1">
            {meta.label} {meta.name}
          </p>
          <p>{meta.nextHint}</p>
          <p className="mt-1 text-text-muted">
            Higher tiers rank higher in retrieval and survive longer.
          </p>
          <p className="mt-1 text-text-muted">
            Confidence: {(confidence * 100).toFixed(0)}%
          </p>
        </div>
      )}
    </div>
  )
}

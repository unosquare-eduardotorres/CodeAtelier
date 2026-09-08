/**
 * VerificationDepthBadge — the depth a blueprint was RUN at, shown after the
 * fact.
 *
 * The depth was previously visible only in the creation form, which meant the
 * one place it matters most — reading a finished run's verdict — never said
 * which level of proof "passed" refers to. The caveat rides along in the title
 * (and optionally inline) because the whole feature exists to stop "it passed"
 * being read as "it works".
 */

import type { JSX } from 'react'
import { ShieldCheck } from 'lucide-react'
import {
  VERIFICATION_DEPTHS,
  resolveVerificationDepth,
  type VerificationDepth
} from '../../../../../shared/blueprint-types'

function depthMeta(depth: VerificationDepth): (typeof VERIFICATION_DEPTHS)[number] | undefined {
  return VERIFICATION_DEPTHS.find((d) => d.value === depth)
}

export function VerificationDepthBadge({
  settingsJson,
  className = ''
}: {
  settingsJson: Record<string, unknown> | null | undefined
  className?: string
}): JSX.Element {
  const depth = resolveVerificationDepth(settingsJson)
  const meta = depthMeta(depth)
  return (
    <span
      data-testid="blueprint-depth-badge"
      title={`Verification depth: ${meta?.label ?? depth}. ${meta?.description ?? ''} ${meta?.caveat ?? ''}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-inset text-text-secondary ${className}`}
    >
      <ShieldCheck size={10} className="flex-shrink-0" />
      {meta?.label ?? depth}
    </span>
  )
}

/** The blunt "what this level still does not prove" line. */
export function VerificationDepthCaveat({
  settingsJson,
  className = ''
}: {
  settingsJson: Record<string, unknown> | null | undefined
  className?: string
}): JSX.Element {
  const meta = depthMeta(resolveVerificationDepth(settingsJson))
  return (
    <span
      data-testid="blueprint-depth-caveat"
      className={`text-[10px] text-text-muted ${className}`}
    >
      Verified at <span className="text-text-secondary">{meta?.label ?? 'Standard'}</span> depth —{' '}
      <span className="text-warning/80">{meta?.caveat}</span>
    </span>
  )
}

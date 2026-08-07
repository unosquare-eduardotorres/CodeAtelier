/**
 * Icon shown next to a plan section heading.
 *
 * emit_plan's sections[].icon is a free string that the model fills with a
 * Lucide id ("alert-triangle", "lucide:list"). It used to be rendered straight
 * into a <span>, so plan cards displayed the literal id as text. Names now
 * resolve to a component; anything not id-shaped (an emoji, which is what
 * older plans stored) still renders as text.
 *
 * Lives in its own module because TaskPlanSections.tsx exports section
 * builders rather than components, and adding a component export there trips
 * react-refresh/only-export-components.
 */
import React from 'react'
import { lucideIconByName } from '@renderer/utils/lucideIconByName'

export function PlanSectionIcon({ icon }: { icon?: string }): React.JSX.Element | null {
  if (!icon) return null
  // Held in a lowercase binding and rendered via createElement: a capitalised
  // binding assigned from a call reads as constructing a component during
  // render to react-hooks. lucideIconByName only ever returns an existing
  // module-level component, never a new one.
  const resolved = lucideIconByName(icon)
  if (resolved) {
    return React.createElement(resolved, { size: 15, className: 'shrink-0 text-mode-plan-text' })
  }
  return <span className="text-base shrink-0">{icon}</span>
}

export default PlanSectionIcon

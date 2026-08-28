/**
 * Off-binding semantics for optional model roles.
 *
 * Most roles are mandatory: an unbound role falls back to DEFAULT_MODEL_CONFIG
 * and the layer runs anyway. Two of the quality layers are OPTIONAL — running
 * them by default would silently add cost and a whole pipeline phase to every
 * existing blueprint — so they are OFF unless the user binds them.
 *
 * Two distinguishable "off" states, both meaning skip-the-layer:
 *   - no entry at all in `modelRoles` for an optional action ("never configured")
 *   - `{ disabled: true }` ("explicitly turned off")
 *
 * The second form exists so the routing UI can round-trip a deliberate "off"
 * without deleting the user's previously chosen model.
 */

import type { ModelAction, ModelOverrides, ModelRoleMap } from './types'

/**
 * Roles that are skipped unless explicitly bound.
 *
 * `blueprint:lead-review` is deliberately NOT here: it is the fixer of last
 * resort in the escalation ladder, so it must always resolve to something.
 */
export const OPTIONAL_MODEL_ROLE_ACTIONS: readonly ModelAction[] = [
  'blueprint:peer-review',
  'blueprint:code-review'
] as const

export function isOptionalRoleAction(action: ModelAction): boolean {
  return OPTIONAL_MODEL_ROLE_ACTIONS.includes(action)
}

/**
 * Is this role bound off? Pure — every input is explicit so both the renderer
 * panel and the main-process pipeline can answer the same question.
 *
 * A legacy `modelOverrides` entry counts as an explicit opt-in for optional
 * roles: users who configured the model in the old editor expect it to run.
 */
export function isRoleDisabled(
  action: ModelAction,
  modelRoles?: ModelRoleMap,
  modelOverrides?: ModelOverrides
): boolean {
  const role = modelRoles?.[action]
  if (role?.disabled === true) return true
  if (!isOptionalRoleAction(action)) return false
  // Optional role: enabled only when something explicitly binds it.
  if (role?.modelId) return false
  if (modelOverrides?.[action]) return false
  return true
}

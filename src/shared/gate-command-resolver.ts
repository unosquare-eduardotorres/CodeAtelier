/**
 * GateCommandResolver — decides which command each gate actually runs.
 *
 * Precedence is per-KIND, not per-source: a workspace override for `test` does
 * not discard the plan's declared `build`. Resolving whole sets as units would
 * make a single override silently blind three other gates.
 *
 * Anything left unresolved means the affected gate returns `unverifiable` with
 * reason `no_command`. It never means `fail`.
 */

import {
  GATE_COMMAND_KINDS,
  sanitizeGateCommandSet,
  type GateCommandKind,
  type GateCommandSet,
  type ResolvedGateCommands
} from './gate-command-types'

export interface GateCommandSources {
  /** Workspace settings — typed by a human. Highest precedence. */
  override?: GateCommandSet
  /** Declared by the PLAN phase artifact. */
  declared?: GateCommandSet
  /** Inferred from manifests on disk. Lowest precedence. */
  detected?: GateCommandSet
}

export function resolveGateCommands(sources: GateCommandSources): ResolvedGateCommands {
  const override = sanitizeGateCommandSet(sources.override)
  const declared = sanitizeGateCommandSet(sources.declared)
  const detected = sanitizeGateCommandSet(sources.detected)

  const resolved: ResolvedGateCommands = {}
  for (const kind of GATE_COMMAND_KINDS) {
    if (override[kind]) {
      resolved[kind] = { ...override[kind]!, provenance: 'override' }
    } else if (declared[kind]) {
      resolved[kind] = { ...declared[kind]!, provenance: 'declared' }
    } else if (detected[kind]) {
      resolved[kind] = { ...detected[kind]!, provenance: 'detected' }
    }
  }
  return resolved
}

/** Which gate kinds have no command at all — these run as `unverifiable`. */
export function unresolvedGateKinds(resolved: ResolvedGateCommands): GateCommandKind[] {
  return GATE_COMMAND_KINDS.filter((kind) => !resolved[kind])
}

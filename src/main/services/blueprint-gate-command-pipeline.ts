/**
 * T003/G1+G6+G7 — the ONE gate-command resolution pipeline.
 *
 * Before this module, three call-sites resolved gate commands independently:
 * the build service's cache rebuild, the verify service's quality-gates block,
 * and retryPhase's stop-loss comparison. They agreed on precedence
 * (override → declared → detected) but NOT on the venv rewrite, so:
 *
 *   - G7: verify-phase resolution skipped the rewrite — a venv declared in the
 *     PLAN ran (rewritten, green) in BUILD and un-rewritten (missing, red) in
 *     VERIFY on the same blueprint;
 *   - G1: retryPhase compared its UN-rewritten resolution against the
 *     REWRITTEN command the stop-loss recorded, the strings differed, and the
 *     exclusion the write site earned was lifted at the read site — feeding the
 *     T003 infinite-retry loop.
 *
 * Standalone module (not a method on BlueprintBuildService) on purpose:
 * `blueprint.service.ts` cannot import the build service (build already
 * imports blueprint.service — a cycle), and the verify service should not gain
 * a build-service dependency for a pure resolution function. Everything here
 * reads repositories and disk only; no service imports.
 */

import log from 'electron-log'

import { resolveGateCommands } from '../../shared/gate-command-resolver'
import { GATE_COMMAND_KINDS, type GateCommandSet } from '../../shared/gate-command-types'
import { rewriteVenvInterpreter } from '../../shared/gate-command-rewrite'
import { parseGateCommands } from '../../shared/blueprint-artifact-parsers'

import { blueprintPhaseRepository } from '../db/repositories/blueprint.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { scanGateCommands } from './blueprint-preflight.service'

const pipelineLog = log.scope('blueprint-gates')

/**
 * The PLAN artifact's declared `gate-commands` blocks, last-match-wins merged
 * (the same parse `parseGateCommands` applies per artifact: within one artifact
 * the LAST block wins, and across artifacts later artifacts win).
 */
export function readDeclaredGateCommands(blueprintId: string): GateCommandSet {
  let declared: GateCommandSet = {}
  try {
    const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
    for (const artifact of planPhase?.artifactsJson ?? []) {
      if (!artifact.contentMd) continue
      const parsed = parseGateCommands(artifact.contentMd)
      if (Object.keys(parsed).length > 0) declared = { ...declared, ...parsed }
    }
  } catch (err) {
    pipelineLog.warn(
      '[gate-commands] Could not read declared gate commands from the PLAN artifact:',
      err
    )
  }
  return declared
}

/**
 * The single resolution pipeline: PLAN parse → precedence resolve
 * (override → declared → detected) → venv rewrite.
 *
 * `scanRoot` is where toolchain detection walks the disk. BUILD passes the
 * SOURCE workspace (detection must see the user's real toolchain, not a sparse
 * worktree checkout); VERIFY passes the execution tree, whose manifests the
 * build just landed — callers keep their existing scan roots, this module
 * fixes the SHARED tail of the pipeline (resolve + rewrite), not the scan.
 *
 * Returns the resolved set plus which kinds the rewrite touched — retryPhase
 * and telemetry assert on that, and callers must not re-derive it.
 */
export function resolveBlueprintGateCommands(
  blueprintId: string,
  workspacePath: string,
  opts: { scanRoot?: string } = {}
): { commands: ReturnType<typeof resolveGateCommands>; venvRewritten: string[] } {
  const settings = workspaceRepository.getSettingsByPath(workspacePath)
  const resolved = resolveGateCommands({
    override: settings?.gateCommands as GateCommandSet | undefined,
    declared: readDeclaredGateCommands(blueprintId),
    detected: scanGateCommands(opts.scanRoot ?? workspacePath)
  })

  // T003 fix — rebind venv interpreter paths to the SOURCE checkout. Applied
  // post-resolution so it covers override/declared/detected alike: a venv is
  // gitignored, so it never exists in a blueprint worktree, and a worktree-
  // relative venv token would fail forever. Runs on every call so a re-detected
  // command also benefits (R2.1 invalidation → rebuild).
  const venvRewritten: string[] = []
  for (const kind of GATE_COMMAND_KINDS) {
    const cmd = resolved[kind]
    if (!cmd?.command) continue
    const r = rewriteVenvInterpreter(cmd.command, {
      sourceRoot: workspacePath,
      // No worktree context here; using the source root for both keeps the
      // precedence check degenerate (source wins), and the result is an
      // ABSOLUTE source path that is valid in any execution tree.
      worktreeRoot: workspacePath
    })
    if (r.rewritten) {
      resolved[kind] = { ...cmd, command: r.command }
      venvRewritten.push(kind)
    }
  }
  if (venvRewritten.length > 0) {
    pipelineLog.info(
      `[gate-commands] Rebound venv interpreter token for ${blueprintId} ` +
        `(kinds: ${venvRewritten.join(', ')}) — source-workspace venvs are reused in worktrees`
    )
  }
  return { commands: resolved, venvRewritten }
}

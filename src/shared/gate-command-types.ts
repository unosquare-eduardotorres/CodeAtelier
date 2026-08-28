/**
 * The shell commands the deterministic gates run, and where they came from.
 *
 * A gate with no resolvable command returns `unverifiable` with reason
 * `no_command` — never `fail`. Blank workspaces are an expected starting state:
 * gates come online progressively as the toolchain appears on disk.
 */

export type GateCommandKind = 'build' | 'lint' | 'test' | 'smoke'

/** Where a command came from. Precedence is override > declared > detected. */
export type GateCommandProvenance =
  /** Typed by a human into workspace settings. Always wins. */
  | 'override'
  /** Declared by the PLAN phase in its `gate-commands` block. */
  | 'declared'
  /** Inferred from manifests on disk (package.json scripts, *.csproj, Cargo.toml…). */
  | 'detected'

export interface GateCommand {
  /** Shell command line, e.g. `npm run lint`. */
  command: string
  /** Working directory relative to the workspace root. Defaults to the root. */
  cwd?: string
}

/** A partially-specified command set. Every key is optional at every layer. */
export interface GateCommandSet {
  build?: GateCommand
  lint?: GateCommand
  test?: GateCommand
  smoke?: GateCommand
}

export interface ResolvedGateCommand extends GateCommand {
  provenance: GateCommandProvenance
}

/** The output of the resolver: per-kind winner plus its provenance. */
export interface ResolvedGateCommands {
  build?: ResolvedGateCommand
  lint?: ResolvedGateCommand
  test?: ResolvedGateCommand
  smoke?: ResolvedGateCommand
}

export const GATE_COMMAND_KINDS: readonly GateCommandKind[] = [
  'build',
  'lint',
  'test',
  'smoke'
] as const

/** Per-gate timeouts. Build is generous — a cold .NET or Rust build is slow. */
export const GATE_TIMEOUTS_MS: Record<GateCommandKind, number> = {
  lint: 5 * 60_000,
  build: 30 * 60_000,
  test: 30 * 60_000,
  smoke: 5 * 60_000
}

/**
 * Reject a command string that could not have come from a toolchain manifest.
 *
 * These commands run in the main process with the user's shell, so a command
 * smuggled in through an LLM-authored `gate-commands` block is a code-execution
 * path. The guard is deliberately blunt: shell metacharacters that chain or
 * redirect are refused outright, because no legitimate gate command needs them
 * (a multi-step gate belongs in a script the repo already has).
 */
const FORBIDDEN_COMMAND_PATTERN = /[;&|><`$(){}\n\r]/

export function isSafeGateCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (trimmed.length > 500) return false
  return !FORBIDDEN_COMMAND_PATTERN.test(trimmed)
}

/**
 * A `cwd` must stay inside the workspace. Absolute paths and `..` traversal are
 * refused rather than clamped — silently rewriting a path the model asked for
 * hides the fact that its declaration was wrong.
 */
export function isSafeGateCwd(cwd: string | undefined): boolean {
  if (cwd === undefined) return true
  if (cwd === '') return false
  if (cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd)) return false
  const parts = cwd.split(/[\\/]/)
  return !parts.includes('..')
}

/** Drop any entry that fails the safety guards. Returns the surviving set. */
export function sanitizeGateCommandSet(set: GateCommandSet | undefined): GateCommandSet {
  if (!set) return {}
  const out: GateCommandSet = {}
  for (const kind of GATE_COMMAND_KINDS) {
    const entry = set[kind]
    if (!entry?.command) continue
    if (!isSafeGateCommand(entry.command)) continue
    if (!isSafeGateCwd(entry.cwd)) continue
    out[kind] = entry.cwd
      ? { command: entry.command.trim(), cwd: entry.cwd }
      : { command: entry.command.trim() }
  }
  return out
}

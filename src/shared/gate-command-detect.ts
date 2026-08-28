/**
 * Deterministic toolchain detection for the gate commands.
 *
 * Pure: the caller reads the disk and hands over a manifest snapshot, so the
 * whole detection matrix is unit-testable without a fixture repo.
 *
 * Detection is the LOWEST-precedence source (override > declared > detected).
 * Guessing wrong is cheap — a declared or overridden command replaces it — but
 * guessing *confidently wrong* is not, so every rule here keys off an explicit
 * signal in a manifest rather than the mere presence of a file extension.
 */

import type { GateCommandSet } from './gate-command-types'

/** A snapshot of the manifests found at (or near) the workspace root. */
export interface WorkspaceManifests {
  /** Raw contents of the root `package.json`, if present. */
  packageJson?: string
  /** Lockfile names found at the root — picks the package manager. */
  lockfiles?: string[]
  /** Relative paths of discovered `*.sln` / `*.csproj` files. */
  dotnetProjects?: string[]
  /** Raw contents of the root `Cargo.toml`, if present. */
  cargoToml?: string
  /** Raw contents of the root `pyproject.toml`, if present. */
  pyprojectToml?: string
  /** True when `pytest.ini` / `tox.ini` / `setup.cfg` is present. */
  hasPytestConfig?: boolean
  /** Raw contents of the root `go.mod`, if present. */
  goMod?: string
}

/** `npm test` on a scaffolded project. Detecting this as a test gate is worse than detecting nothing. */
const PLACEHOLDER_TEST_SCRIPT = /no test specified|exit\s+1/i

function parseScripts(packageJson: string | undefined): Record<string, string> {
  if (!packageJson) return {}
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> }
    const scripts = parsed.scripts
    if (!scripts || typeof scripts !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(scripts)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    // A malformed package.json is a real condition (mid-edit, merge conflict).
    // Detecting nothing yields `unverifiable`, which is the honest answer.
    return {}
  }
}

/** npm / pnpm / yarn / bun — decided by lockfile, defaulting to npm. */
export function detectPackageManager(
  lockfiles: readonly string[] = []
): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const names = new Set(lockfiles.map((f) => f.split(/[\\/]/).pop() ?? f))
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun'
  if (names.has('yarn.lock')) return 'yarn'
  return 'npm'
}

function runScript(pm: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string {
  // yarn and bun take the script name directly; npm and pnpm need `run`.
  return pm === 'yarn' || pm === 'bun' ? `${pm} ${script}` : `${pm} run ${script}`
}

/** First script name present in `scripts`, in preference order. */
function pickScript(
  scripts: Record<string, string>,
  candidates: readonly string[]
): string | undefined {
  return candidates.find((name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '')
}

/**
 * The directory a .NET command should run in: the solution's folder when there
 * is exactly one `.sln`, otherwise the repo root (where `dotnet build` will
 * find a single project on its own).
 */
function dotnetCwd(projects: readonly string[]): string | undefined {
  const solutions = projects.filter((p) => p.toLowerCase().endsWith('.sln'))
  if (solutions.length !== 1) return undefined
  const dir = solutions[0].split(/[\\/]/).slice(0, -1).join('/')
  return dir === '' ? undefined : dir
}

export function detectGateCommands(manifests: WorkspaceManifests): GateCommandSet {
  const out: GateCommandSet = {}

  // ── Node / JS ──
  const scripts = parseScripts(manifests.packageJson)
  if (Object.keys(scripts).length > 0) {
    const pm = detectPackageManager(manifests.lockfiles)

    // Typecheck before build: it answers the same "does it compile" question
    // an order of magnitude faster, which matters when it runs after every task.
    const buildScript = pickScript(scripts, ['typecheck', 'type-check', 'build', 'compile'])
    if (buildScript) out.build = { command: runScript(pm, buildScript) }

    const lintScript = pickScript(scripts, ['lint'])
    if (lintScript) out.lint = { command: runScript(pm, lintScript) }

    const testScript = pickScript(scripts, ['test:unit', 'test'])
    if (testScript && !PLACEHOLDER_TEST_SCRIPT.test(scripts[testScript])) {
      out.test = { command: runScript(pm, testScript) }
    }

    const smokeScript = pickScript(scripts, ['smoke', 'test:smoke'])
    if (smokeScript) out.smoke = { command: runScript(pm, smokeScript) }
  }

  // ── .NET ──
  const dotnet = manifests.dotnetProjects ?? []
  if (dotnet.length > 0) {
    const cwd = dotnetCwd(dotnet)
    if (!out.build) out.build = cwd ? { command: 'dotnet build', cwd } : { command: 'dotnet build' }
    if (!out.test) out.test = cwd ? { command: 'dotnet test', cwd } : { command: 'dotnet test' }
  }

  // ── Rust ──
  if (manifests.cargoToml) {
    if (!out.build) out.build = { command: 'cargo build' }
    if (!out.test) out.test = { command: 'cargo test' }
    // `cargo clippy` is a separate rustup component that may not be installed.
    // Detecting it here would turn a missing tool into a red lint gate, so the
    // lint gate stays unresolved (→ unverifiable) unless the plan declares it.
  }

  // ── Go ──
  if (manifests.goMod) {
    if (!out.build) out.build = { command: 'go build ./...' }
    if (!out.test) out.test = { command: 'go test ./...' }
    if (!out.lint) out.lint = { command: 'go vet ./...' }
  }

  // ── Python ──
  const pyproject = manifests.pyprojectToml
  if (pyproject || manifests.hasPytestConfig) {
    if (!out.test) out.test = { command: 'pytest' }
    // Only claim a linter/typechecker the project actually configures.
    if (!out.lint && pyproject?.includes('[tool.ruff')) out.lint = { command: 'ruff check .' }
    if (!out.build && pyproject?.includes('[tool.mypy')) out.build = { command: 'mypy .' }
  }

  return out
}

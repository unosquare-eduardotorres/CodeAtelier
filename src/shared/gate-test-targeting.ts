/**
 * Ecosystem test-targeting templates (R3.1 — decides M2.6: Option 2).
 *
 * Builds a NARROW test command for a task's declared test files, keyed off the
 * detected toolchain. Precedence at the call-site:
 *
 *   packet `testCommand` (override)  >  template built here (default)  >  none
 *
 * The FULL suite is never built here — it belongs to VERIFY (M8), where the
 * whole blueprint is graded as one unit. A per-task gate that silently ran the
 * full suite would be slow AND dishonest: green unrelated tests would paper
 * over this task's untested code.
 *
 * Every generated command must pass `isSafeGateCommand`: paths are reduced to a
 * conservative safe-set, and any file that cannot be named safely is dropped
 * rather than escaped (a dropped file narrows the run; an escaped one could
 * widen it into a shell injection).
 */

import type { WorkspaceManifests } from './gate-command-detect'

/** Toolchains we know how to target per-file or per-package. */
export type TestTargetingToolchain = 'vitest' | 'jest' | 'pytest' | 'dotnet' | 'go' | 'cargo'

/**
 * Repo-relative paths we are willing to put on a command line verbatim.
 * Anything outside this set (spaces, quotes, metacharacters, unicode) is
 * dropped — see the file header for why escaping is the wrong move.
 */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/

function safeFiles(files: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of files) {
    const trimmed = f.trim().replace(/\\/g, '/')
    if (!trimmed || !SAFE_PATH.test(trimmed) || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Build the narrow test command for `files` under `toolchain`.
 *
 * Returns null when the toolchain cannot honestly target the given files
 * (e.g. `cargo test` has no file filter, `dotnet test` filters by test name
 * not path) — the caller then reports `no_command`, which is the truthful
 * verdict, never a disguised full-suite run.
 */
export function buildTestCommand(
  toolchain: TestTargetingToolchain | undefined,
  files: readonly string[]
): string | null {
  if (!toolchain) return null
  const safe = safeFiles(files)
  if (safe.length === 0) return null

  switch (toolchain) {
    case 'vitest':
      // `vitest run` (non-watch) with explicit paths; filters by path substring.
      return `npx vitest run ${safe.join(' ')}`
    case 'jest':
      // Jest takes positional regex patterns; exact-ish paths work as patterns.
      return `npx jest ${safe.join(' ')}`
    case 'pytest':
      return `pytest ${safe.join(' ')}`
    case 'go': {
      // Go targets PACKAGES, not files: map each _test.go file to its package
      // directory. Non-test files contribute their package too — the task's
      // code and its tests live in the same package.
      const pkgs = new Set<string>()
      for (const f of safe) {
        const parts = f.split('/')
        parts.pop()
        const dir = parts.join('/')
        pkgs.add(dir === '' ? '.' : `./${dir}`)
      }
      return pkgs.size === 0 ? null : `go test ${[...pkgs].join(' ')}`
    }
    case 'dotnet': {
      // `dotnet test` accepts a project/solution path, not a source file. Only
      // honest targeting: the file IS a project file.
      const projects = safe.filter((f) => f.toLowerCase().endsWith('.csproj'))
      return projects.length === 1 ? `dotnet test ${projects[0]}` : null
    }
    case 'cargo': {
      // `cargo test --test <name>` targets one integration-test target in
      // tests/<name>.rs. Unit tests in src/ cannot be targeted by path.
      const targets = safe
        .filter((f) => f.startsWith('tests/') && f.endsWith('.rs'))
        .map((f) => `--test ${f.slice('tests/'.length, -'.rs'.length)}`)
      return targets.length === 1 ? `cargo test ${targets[0]}` : null
    }
    default:
      return null
  }
}

/**
 * Infer the test-targeting toolchain from the same manifest snapshot the gate
 * command detector uses. Explicit dependency/config signals only — see the
 * detection philosophy in `gate-command-detect.ts`.
 */
export function detectTestToolchain(manifests: WorkspaceManifests): TestTargetingToolchain | null {
  // ── Node: vitest or jest, decided by devDependencies/config files ──
  if (manifests.packageJson) {
    if (/"(vitest|@vitest\/ui)"\s*:/.test(manifests.packageJson) || manifests.lockfiles?.some((f) => f.includes('vitest'))) {
      return 'vitest'
    }
    if (/"jest"\s*:/.test(manifests.packageJson)) return 'jest'
  }

  // ── Python ──
  if (manifests.pyprojectToml?.includes('pytest') || manifests.hasPytestConfig) return 'pytest'

  // ── .NET ──
  if ((manifests.dotnetProjects ?? []).some((p) => p.toLowerCase().endsWith('.csproj'))) {
    return 'dotnet'
  }

  // ── Rust ──
  if (manifests.cargoToml) return 'cargo'

  // ── Go ──
  if (manifests.goMod) return 'go'

  return null
}

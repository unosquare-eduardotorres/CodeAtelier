/**
 * C# lint baseline via `dotnet format`.
 *
 * ESLint gives JS/TS repos a lint baseline; C# repos had none, so the blueprint
 * REVIEW phase reported "no lint baseline could be established" on every .NET
 * codebase. This module supplies that baseline using the SDK the repo already
 * builds with — no new analyzer to install.
 *
 * Two facts below are measured against `dotnet 10.0.102`, not assumed:
 *
 *  1. `--verify-no-changes` is MANDATORY. `dotnet format` REWRITES SOURCE by
 *     default, so omitting it would make an audit silently reformat the user's
 *     repository. There is a unit test asserting the flag is always present.
 *  2. `--include` paths must be relative to the project directory AND the
 *     project path must be symlink-resolved. An absolute include matches zero
 *     files; so does a relative include when the project is addressed through a
 *     symlinked path (macOS `/var` → `/private/var`). Either way the run exits 0
 *     with an empty report — a false "clean" lint baseline, which is worse than
 *     an error because nothing looks wrong.
 *
 * Exit code 2 means "diagnostics found", not "failure" — mirroring how the
 * ESLint path treats a dirty repo as a result rather than a crash.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

export interface DotnetDiagnostic {
  file: string
  line: number
  column: number
  id: string
  description: string
}

export type DotnetLintFailure =
  'no-sdk' | 'no-project' | 'non-sdk-project' | 'restore-required' | 'timeout' | 'error'

export interface DotnetLintResult {
  ok: boolean
  diagnostics: DotnetDiagnostic[]
  /** Project or solution the baseline was established against. */
  project?: string
  /** Set when `ok` is false — §7 asks WHICH baseline could not be established. */
  failure?: DotnetLintFailure
  message?: string
}

/** Timeout: MSBuild project load dominates and is slow on first run. */
export const DOTNET_FORMAT_TIMEOUT_MS = 120_000

// ── SDK probe (memoized, mirrors resolveEslintStrategy) ─────────────────────

let sdkAvailable: boolean | undefined

export function isDotnetAvailable(): boolean {
  if (sdkAvailable !== undefined) return sdkAvailable
  try {
    execFileSync('dotnet', ['--version'], {
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    sdkAvailable = true
  } catch {
    sdkAvailable = false
  }
  return sdkAvailable
}

/** Test hook — clears the memoized probe. */
export function resetDotnetProbe(): void {
  sdkAvailable = undefined
}

// ── Project discovery ───────────────────────────────────────────────────────

/**
 * `dotnet format` needs a project or solution to load; a loose tree of `.cs`
 * files has nothing to open. Walk up from the target for the nearest `*.sln`,
 * falling back to `*.csproj` (a solution covers more of the repo in one pass).
 */
export function findDotnetProject(startDir: string, stopDir?: string): string | null {
  let dir = startDir
  const stop = stopDir ? path.resolve(stopDir) : path.parse(startDir).root
  for (;;) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    const sln = entries.find((f) => f.toLowerCase().endsWith('.sln'))
    if (sln) return path.join(dir, sln)
    const proj = entries.find((f) => f.toLowerCase().endsWith('.csproj'))
    if (proj) return path.join(dir, proj)

    const parent = path.dirname(dir)
    if (dir === stop || parent === dir) return null
    dir = parent
  }
}

/**
 * SDK-style projects declare `Sdk="Microsoft.NET.Sdk"`. `dotnet format` cannot
 * load a legacy .NET Framework project, so detect that up front and report the
 * real cause rather than an MSBuild stack trace.
 */
export function isSdkStyleProject(projectPath: string): boolean {
  if (projectPath.toLowerCase().endsWith('.sln')) return true // solutions are mixed; let it run
  try {
    const xml = readFileSync(projectPath, 'utf-8')
    return /<Project[^>]*\sSdk\s*=/.test(xml) || /<Sdk\s/.test(xml)
  } catch {
    return false
  }
}

// ── Command construction ────────────────────────────────────────────────────

/**
 * Build the argv for `dotnet`. `--verify-no-changes` is unconditional: it is
 * the ONLY thing standing between an audit and rewriting the user's source.
 */
export function buildFormatArgs(
  projectPath: string,
  reportDir: string,
  includeRelPaths: string[]
): string[] {
  const args = [
    'format',
    'style',
    projectPath,
    '--verify-no-changes',
    '--no-restore',
    '--severity',
    'info',
    '--report',
    reportDir,
    '-v',
    'quiet'
  ]
  if (includeRelPaths.length > 0) args.push('--include', ...includeRelPaths)
  return args
}

/**
 * Convert scan paths into project-relative includes.
 * Absolute includes match nothing (measured), and a path outside the project
 * directory cannot be expressed — those are dropped, which widens the scan to
 * the whole project rather than silently reporting a false "clean".
 */
export function toProjectRelativeIncludes(absPaths: string[], projectDir: string): string[] {
  const rels: string[] = []
  for (const abs of absPaths) {
    const rel = path.relative(projectDir, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    rels.push(rel.split(path.sep).join('/'))
  }
  return rels
}

// ── Report parsing ──────────────────────────────────────────────────────────

interface RawFileChange {
  LineNumber?: number
  CharNumber?: number
  DiagnosticId?: string
  FormatDescription?: string
}
interface RawReportEntry {
  FilePath?: string
  FileName?: string
  FileChanges?: RawFileChange[]
}

/**
 * Parse `format-report.json`. Shape pinned against a real `dotnet format`
 * run: an ARRAY of entries, one per diagnostic — the same file appears
 * repeatedly, so consumers must aggregate rather than assume file uniqueness.
 */
export function parseFormatReport(json: string, workspacePath?: string): DotnetDiagnostic[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const out: DotnetDiagnostic[] = []
  for (const entry of raw as RawReportEntry[]) {
    const abs = entry?.FilePath ?? entry?.FileName ?? ''
    const file =
      workspacePath && abs.startsWith(workspacePath)
        ? path.relative(workspacePath, abs).split(path.sep).join('/')
        : abs
    for (const change of entry?.FileChanges ?? []) {
      out.push({
        file,
        line: change.LineNumber ?? 0,
        column: change.CharNumber ?? 0,
        id: change.DiagnosticId ?? 'unknown',
        description: change.FormatDescription ?? ''
      })
    }
  }
  return out
}

/** Map a `dotnet format` stderr blob onto the cause we can report. */
export function classifyDotnetError(stderr: string): DotnetLintFailure {
  const s = stderr.toLowerCase()
  if (s.includes('could not find a msbuild project file')) return 'no-project'
  if (
    s.includes('project.assets.json') ||
    s.includes('run a nuget package restore') ||
    s.includes('nu1') ||
    s.includes('assets file')
  ) {
    return 'restore-required'
  }
  if (s.includes('msb4025') || s.includes('is not supported') || s.includes('toolsversion')) {
    return 'non-sdk-project'
  }
  return 'error'
}

/** Human-readable cause, so REVIEW can say WHICH baseline is missing and why. */
export function describeFailure(failure: DotnetLintFailure, project?: string): string {
  switch (failure) {
    case 'no-sdk':
      return 'the .NET SDK is not on PATH (`dotnet --version` failed)'
    case 'no-project':
      return 'no .sln or .csproj was found — `dotnet format` needs a project to load'
    case 'non-sdk-project':
      return `${project ?? 'the project'} is not SDK-style (legacy .NET Framework), which \`dotnet format\` cannot load`
    case 'restore-required':
      return 'the project needs `dotnet restore` first (no assets file)'
    case 'timeout':
      return `\`dotnet format\` exceeded ${DOTNET_FORMAT_TIMEOUT_MS / 1000}s (MSBuild load)`
    default:
      return '`dotnet format` failed'
  }
}

/** Symlink-resolve a path, falling back to the input when it does not exist. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Establish a C# lint baseline for the given absolute paths.
 * Never throws — every failure mode is returned with its own cause.
 */
export interface DotnetRunPlan {
  /** Symlink-resolved project/solution passed to `dotnet format`. */
  project: string
  /** Symlink-resolved directory used as the working directory. */
  projectDir: string
  /** Project-relative include paths. */
  includes: string[]
}

/**
 * Decide what to run, without running it — the part worth regression-testing,
 * because a wrong plan yields a silent false "clean" instead of an error.
 */
export function planDotnetRun(
  absPaths: string[],
  workspacePath: string
): DotnetRunPlan | { failure: DotnetLintFailure; project?: string } {
  const first = absPaths[0]
  if (!first) return { failure: 'no-project' }
  const startDir = existsSync(first) && path.extname(first) ? path.dirname(first) : first
  const project = findDotnetProject(startDir, workspacePath)
  if (!project) return { failure: 'no-project' }
  if (!isSdkStyleProject(project)) return { failure: 'non-sdk-project', project }

  // Symlink-resolve everything: an unresolved project path makes `--include`
  // match nothing, and `dotnet format` then exits 0 reporting CLEAN.
  const resolved = realOrSelf(project)
  const projectDir = path.dirname(resolved)
  return {
    project: resolved,
    projectDir,
    includes: toProjectRelativeIncludes(absPaths.map(realOrSelf), projectDir)
  }
}

export function runDotnetLint(absPaths: string[], workspacePath: string): DotnetLintResult {
  if (!isDotnetAvailable()) {
    return { ok: false, diagnostics: [], failure: 'no-sdk' }
  }

  const plan = planDotnetRun(absPaths, workspacePath)
  if ('failure' in plan) {
    return { ok: false, diagnostics: [], failure: plan.failure, project: plan.project }
  }
  const { project, projectDir, includes } = plan
  const reportDir = mkdtempSync(path.join(tmpdir(), 'agentstudio-dotnet-format-'))
  const args = buildFormatArgs(project, reportDir, includes)

  try {
    execFileSync('dotnet', args, {
      cwd: projectDir,
      timeout: DOTNET_FORMAT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (err) {
    // Exit 2 = diagnostics found. That is a RESULT, not a failure — the report
    // is written either way, so only treat it as an error if there is no report.
    const e = err as { signal?: string; code?: string; stderr?: string | Buffer }
    const reportPath = path.join(reportDir, 'format-report.json')
    if (!existsSync(reportPath)) {
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        return { ok: false, diagnostics: [], failure: 'timeout', project }
      }
      const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '')
      return {
        ok: false,
        diagnostics: [],
        failure: classifyDotnetError(stderr),
        project,
        message: stderr.split('\n')[0]?.slice(0, 300)
      }
    }
  }

  const reportPath = path.join(reportDir, 'format-report.json')
  if (!existsSync(reportPath)) {
    return { ok: false, diagnostics: [], failure: 'error', project, message: 'no report produced' }
  }
  return {
    ok: true,
    project,
    // The report carries resolved paths, so relativise against the resolved
    // workspace or every row would come back absolute.
    diagnostics: parseFormatReport(readFileSync(reportPath, 'utf-8'), realOrSelf(workspacePath))
  }
}

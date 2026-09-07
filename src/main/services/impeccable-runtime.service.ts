/**
 * Impeccable engine runtime resolution.
 *
 * This module is the ONLY place in the codebase that knows where the Impeccable
 * engine lives or how to spawn it. Everything else (provisioning, the detector,
 * preflight probes) goes through `resolveEngineBinary()` / `runEngine()`, so an
 * upstream layout change is a one-file edit.
 *
 * ── Why we spawn the platform binary directly, never the npm shim ────────────
 * The `impeccable` npm package ships only a 4 KB Node launcher
 * (`cli/bin/cli.js`). The real engine is a self-contained ~12.7 MB native
 * binary published as an `os`/`cpu`-gated optional dependency
 * (`@impeccable/cli-<os>-<arch>`), so npm installs exactly one — the host's.
 *
 * Running the shim would require a Node runtime. In the packaged app we cannot
 * rely on one: `build/afterPack.js` burns `RunAsNode: false`, which disables
 * the `ELECTRON_RUN_AS_NODE=1` trick `node-runtime.ts` uses elsewhere, and
 * end-user machines frequently have no Node at all (incident 2026-08). The
 * engine binary needs no runtime, so we exec it directly and sidestep the fuse
 * entirely.
 *
 * ── Version vocabulary (three different numbers, do not conflate) ────────────
 *   • npm package version   — `4.0.4`  (what `package.json` pins; the shim's
 *                                       `--version` reports this)
 *   • engine binary version — `0.1.3`  (the optionalDependency range; what the
 *                                       binary's own `--version` reports)
 *   • skill content version — `4.2.2`  (frontmatter inside the installed
 *                                       SKILL.md)
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { skillLogger } from '../logger'

/**
 * Logging must never be the thing that breaks resolution: `resolveEngineBinary`
 * and `runEngine` both promise never to throw, and the unit harness can leave
 * `../logger` partially mocked (a test that overwrites its require.cache entry
 * makes some scopes `undefined`).
 */
const log = {
  info: (msg: string): void => skillLogger?.info?.(msg),
  warn: (msg: string): void => skillLogger?.warn?.(msg)
}

/** Budget for the `--version` availability probe. Mirrors blueprint-preflight. */
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000

/**
 * Engine binary version, pinned in `impeccable`'s optionalDependencies.
 * Used to locate the launcher's version-partitioned download cache
 * (`~/.impeccable/bin/<version>/`). Kept in sync with the `impeccable` pin in
 * package.json — see `docs/plans/design-audit-impeccable.md`.
 */
export const IMPECCABLE_ENGINE_VERSION = '0.1.3'

/** The exact npm package version pinned in package.json dependencies. */
export const IMPECCABLE_PACKAGE_VERSION = '4.0.4'

/**
 * Maps the running platform to its engine package name and executable name,
 * replicating the mapping in `impeccable/cli/bin/cli.js`.
 *
 * Note the OS token is `windows`, NOT node's `win32` — the published package is
 * `@impeccable/cli-windows-x64`.
 */
export function resolvePlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { target: string; packageName: string; exeName: string } | null {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as string]
  const cpu = { arm64: 'arm64', x64: 'x64' }[arch]
  if (!os || !cpu) return null
  const target = `${os}-${cpu}`
  return {
    target,
    packageName: `@impeccable/cli-${target}`,
    exeName: os === 'windows' ? 'impeccable.exe' : 'impeccable'
  }
}

/** True when `p` is an existing file we are allowed to execute. */
function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Application root that contains `node_modules`.
 *
 * Mirrors the dev/packaged split at `skill-prompt-composer.ts:313` — including
 * its defensive try/catch, because `electron` is unresolvable when this module
 * is loaded outside an app context (unit tests, scripts).
 */
function resolveAppRoot(): string {
  if (appRootOverride) return appRootOverride
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- defensive lazy load; electron may be unavailable in non-app contexts
    const { app } = require('electron')
    return app.isPackaged ? app.getAppPath() : process.cwd()
  } catch {
    return process.cwd()
  }
}

let appRootOverride: string | null = null

/**
 * Test seam for the node_modules search root.
 *
 * Exists so tests can make the bundled-dependency tier miss without calling
 * `process.chdir()`. The harness runs suites concurrently, so mutating cwd
 * corrupts unrelated tests that resolve paths against it.
 */
export function __setAppRootForTests(root: string | null): void {
  appRootOverride = root
  cachedBinary = undefined
}

let cachedBinary: string | null | undefined

/** Clears memoised resolution + availability state. Test seam. */
export function resetImpeccableRuntimeCache(): void {
  cachedBinary = undefined
  cachedAvailability = undefined
  availabilityInFlight = undefined
}

/**
 * Locate the Impeccable engine binary. First hit wins; the result (including a
 * negative result) is memoised for the process.
 *
 * Resolution order mirrors the upstream launcher so we find whatever it would:
 *   0. `IMPECCABLE_BIN` env override — upstream's highest-priority escape hatch.
 *   1. The bundled optional dependency under the app's node_modules.
 *   2. The launcher's own version-partitioned download cache.
 *   3. `impeccable` on PATH.
 *
 * Returns `null` rather than throwing — a missing engine is a degraded state,
 * never a crash.
 */
export function resolveEngineBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary

  const platform = resolvePlatformTarget()
  if (!platform) {
    log.warn(
      `[impeccable] unsupported platform ${process.platform}/${process.arch} — engine unavailable`
    )
    cachedBinary = null
    return cachedBinary
  }

  const candidates: string[] = []

  // 0. Explicit override (upstream honors this first).
  const envBin = process.env.IMPECCABLE_BIN
  if (envBin) candidates.push(envBin)

  // 1. Bundled optional dependency. `app.getAppPath()` when packaged so this
  //    resolves inside Contents/Resources/app; cwd in dev.
  candidates.push(
    join(resolveAppRoot(), 'node_modules', platform.packageName, 'bin', platform.exeName)
  )

  // 2. Launcher download cache. Version-partitioned, and relocatable via
  //    IMPECCABLE_HOME — both behaviours copied from cli/bin/cli.js.
  const cacheRoot = process.env.IMPECCABLE_HOME || join(homedir(), '.impeccable')
  candidates.push(join(cacheRoot, 'bin', IMPECCABLE_ENGINE_VERSION, platform.exeName))

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      log.info(`[impeccable] engine resolved: ${candidate}`)
      cachedBinary = candidate
      return cachedBinary
    }
  }

  // 3. Bare name — let the OS search PATH. We cannot stat-check this one, so it
  //    is only trusted if the availability probe later succeeds.
  log.warn('[impeccable] no engine binary found on disk; falling back to PATH lookup')
  cachedBinary = platform.exeName
  return cachedBinary
}

export interface EngineRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the engine could not be spawned at all. */
  error?: string
}

/**
 * The single spawn point for the Impeccable engine. Never throws and never
 * rejects — callers branch on `code` / `error` / `timedOut`.
 *
 * `maxBuffer` is raised because `detect --json` over a large workspace can emit
 * well past node's 1 MB default, which would otherwise surface as a truncated
 * parse failure.
 */
export function runEngine(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<EngineRunResult> {
  const bin = resolveEngineBinary()
  if (!bin) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'impeccable engine not available'
    })
  }

  return new Promise<EngineRunResult>((resolve) => {
    let settled = false
    const finish = (result: EngineRunResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const child = execFile(
        bin,
        args,
        {
          encoding: 'utf-8',
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 32 * 1024 * 1024,
          env: options.env ?? process.env,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? '')
          const errOut = String(stderr ?? '')
          if (err) {
            const execErr = err as ExecFileException
            // `killed` is how execFile reports a timeout kill.
            const timedOut = execErr.killed === true || execErr.signal != null
            // A non-zero exit is NOT an error for this wrapper: the detector
            // uses exit 2 to mean "findings present". Report the code and let
            // the caller decide.
            const code = typeof execErr.code === 'number' ? execErr.code : null
            finish({
              code,
              stdout: out,
              stderr: errOut,
              timedOut,
              error: code === null && !timedOut ? execErr.message : undefined
            })
          } else {
            finish({ code: 0, stdout: out, stderr: errOut, timedOut: false })
          }
        }
      )
      child.on('error', (err) => {
        finish({ code: null, stdout: '', stderr: '', timedOut: false, error: err.message })
      })
    } catch (err) {
      finish({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

export interface ImpeccableAvailability {
  available: boolean
  path?: string
  /** Engine binary version (e.g. "0.1.3"), not the npm package version. */
  version?: string
  reason?: string
}

let cachedAvailability: ImpeccableAvailability | undefined
let availabilityInFlight: Promise<ImpeccableAvailability> | undefined

/**
 * Probe the engine with `--version`. Result is memoised for the app session;
 * concurrent callers share one in-flight probe.
 *
 * Unavailable is a warning state, never a crash — the LLM half of a design
 * audit still works without the deterministic detector.
 */
export function checkAvailability(): Promise<ImpeccableAvailability> {
  if (cachedAvailability) return Promise.resolve(cachedAvailability)
  if (availabilityInFlight) return availabilityInFlight

  availabilityInFlight = (async (): Promise<ImpeccableAvailability> => {
    const bin = resolveEngineBinary()
    if (!bin) {
      return { available: false, reason: 'no engine binary for this platform' }
    }

    const result = await runEngine(['--version'], { timeoutMs: AVAILABILITY_PROBE_TIMEOUT_MS })

    if (result.timedOut) {
      return { available: false, path: bin, reason: 'version probe timed out' }
    }
    if (result.error) {
      return { available: false, path: bin, reason: result.error }
    }
    if (result.code !== 0) {
      return {
        available: false,
        path: bin,
        reason: `version probe exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`
      }
    }

    const version = result.stdout.trim().split(/\s+/).pop() || undefined
    return { available: true, path: bin, version }
  })()
    .catch((err): ImpeccableAvailability => ({
      available: false,
      reason: err instanceof Error ? err.message : String(err)
    }))
    .then((res) => {
      cachedAvailability = res
      availabilityInFlight = undefined
      if (!res.available) log.warn(`[impeccable] unavailable: ${res.reason}`)
      return res
    })

  return availabilityInFlight
}

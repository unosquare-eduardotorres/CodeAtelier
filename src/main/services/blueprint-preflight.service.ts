/**
 * Blueprint Environment Preflight — check engine + service registry.
 *
 * Validates external dependencies (CLI tools, env vars, service connectivity)
 * before the BUILD phase. Checks are deterministic (workspace scan, async
 * probes, env presence) — cheap and parallelisable (5s total budget).
 *
 * Design decisions:
 * - Dual-source detection: deterministic scan is the backbone, LLM declaration additive
 * - Connectivity failure = warning, never hard blocker (G8)
 * - All probes parallel + Promise.race hard timeout (5s total, premortem #4)
 * - Results carry key **names** only, never secret values (G3, premortem #5)
 * - Zero new machine states — rides existing approval gate (G5)
 * - Login-shell env sourcing for macOS GUI-launched Electron (A2a fix)
 * - Env-var severity tiers: critical (blocker) vs optional (warn) (B5)
 *
 * @module blueprint-preflight
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawnSync, type ExecFileException } from 'node:child_process'
import log from 'electron-log'

import { collectCandidateDirs } from './tech-stack-detector.service'
import type {
  PreflightCheck,
  PreflightCheckStatus,
  PreflightDetectionSource,
  PreflightResult,
  PreflightServiceDef
} from '../../shared/preflight-types'
import { detectGateCommands, type WorkspaceManifests } from '../../shared/gate-command-detect'
import type { GateCommandSet } from '../../shared/gate-command-types'

const pfLog = log.scope('blueprint-preflight')

/** Global budget (ms) for all CLI probes combined. Unfinished probes → warn. */
const PROBE_BUDGET_MS = 5000

// ── Known Services Registry (G1: start small, grow conservatively) ──

export const KNOWN_SERVICES: PreflightServiceDef[] = [
  {
    id: 'supabase',
    name: 'Supabase',
    packagePatterns: ['@supabase/supabase-js', 'supabase'],
    fileMarkers: ['supabase/config.toml', '.supabase'],
    taskKeywords: ['supabase'],
    requiredEnvVars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
    optionalEnvVars: ['SUPABASE_SERVICE_ROLE_KEY'],
    presenceProbe: { cmd: 'supabase', args: ['--version'] },
    livenessProbe: { cmd: 'supabase', args: ['status'] },
    installHint: 'brew install supabase/tap/supabase  (or see https://supabase.com/docs/guides/cli)'
  },
  {
    id: 'docker',
    name: 'Docker',
    packagePatterns: [],
    fileMarkers: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore'],
    taskKeywords: ['docker', 'dockerfile'], // B7: removed 'container' (React false positive)
    requiredEnvVars: [],
    presenceProbe: { cmd: 'docker', args: ['--version'] },
    livenessProbe: { cmd: 'docker', args: ['info'] }, // G7: daemon running check
    installHint: 'Install Docker Desktop: https://docs.docker.com/get-docker/'
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    packagePatterns: ['pg', 'knex', 'prisma', 'drizzle-orm', 'typeorm', 'sequelize'],
    fileMarkers: ['prisma/schema.prisma'],
    taskKeywords: ['postgres', 'postgresql', 'psql'], // B7: removed 'database migration' (SQLite false positive)
    requiredEnvVars: ['DATABASE_URL'],
    // Projects that split read/write connections (e.g. Congruity HR's
    // DB_READ_DSN/DB_WRITE_DSN convention) satisfy the same requirement —
    // either DSN present means the DB connection is configured.
    envVarAlternatives: {
      DATABASE_URL: ['DB_READ_DSN', 'DB_WRITE_DSN', 'POSTGRES_URL', 'PG_URL']
    },
    presenceProbe: { cmd: 'psql', args: ['--version'] },
    presenceWarnOnly: true, // B5: hosted DBs don't need local psql
    installHint: 'brew install postgresql  (or use Docker: docker run -p 5432:5432 postgres)'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    packagePatterns: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js'],
    fileMarkers: [],
    taskKeywords: ['stripe'], // B7: removed 'payment', 'billing' (generic false positives)
    requiredEnvVars: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'],
    optionalEnvVars: ['STRIPE_WEBHOOK_SECRET'], // B5: many projects don't use webhooks
    presenceProbe: { cmd: 'stripe', args: ['--version'] },
    installHint:
      'brew install stripe/stripe-cli/stripe  (or see https://stripe.com/docs/stripe-cli)'
  },
  {
    id: 'firebase',
    name: 'Firebase',
    packagePatterns: ['firebase', 'firebase-admin', '@firebase/app'],
    fileMarkers: ['firebase.json', '.firebaserc'],
    taskKeywords: ['firebase', 'firestore', 'cloud functions'],
    requiredEnvVars: [],
    optionalEnvVars: ['FIREBASE_PROJECT_ID'], // B5: normally in .firebaserc, not env
    presenceProbe: { cmd: 'firebase', args: ['--version'] },
    installHint: 'npm install -g firebase-tools'
  }
]

// ── Internal helpers ──

/**
 * Parse a dotenv-style file into a Map of key → value.
 * Returns empty map if the file doesn't exist or can't be parsed.
 *
 * Handles: `export KEY=val`, inline comments (`KEY=val # comment`),
 * quoted values, and empty lines/comment-only lines.
 */
export function parseDotenvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!existsSync(filePath)) return result

  try {
    const content = readFileSync(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      let trimmed = line.trim()
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue
      // A13 fix: strip `export ` prefix
      if (trimmed.startsWith('export ')) trimmed = trimmed.substring(7).trim()
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.substring(0, eqIdx).trim()
      let value = trimmed.substring(eqIdx + 1).trim()
      // Strip surrounding quotes first — if quoted, inline comments are part of the value
      const isQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      if (isQuoted) {
        value = value.slice(1, -1)
      } else {
        // A13 fix: strip inline comments for unquoted values
        const commentIdx = value.indexOf(' #')
        if (commentIdx > 0) value = value.substring(0, commentIdx).trim()
      }
      result.set(key, value)
    }
  } catch (err) {
    pfLog.warn(`Failed to parse dotenv file ${filePath}: ${err}`)
  }

  return result
}

/**
 * Read all keys from .env.example (if present) — these represent
 * env vars the project expects to have set.
 */
function readEnvExampleKeys(workspacePath: string): string[] {
  const examplePath = join(workspacePath, '.env.example')
  const envMap = parseDotenvFile(examplePath)
  return Array.from(envMap.keys())
}

// ── Login-shell env sourcing (A2a/B6: macOS GUI-launched Electron fix) ──

/** Cached login-shell env keys — populated once per app session. */
let loginShellEnvCache: Set<string> | null = null
let loginShellEnvPending: Promise<Set<string>> | null = null

/**
 * Capture env vars from the user's login shell.
 * macOS Dock-launched Electron doesn't inherit shell env (e.g. `~/.zshrc` exports).
 * This mirrors the well-known GUI-launch PATH fix already in augmentOpenCodeCliPath.
 *
 * Runs `$SHELL -ilc printenv` with a 5s timeout, caches the result for the session.
 * Returns an empty set on failure (non-fatal).
 */
export async function captureLoginShellEnv(): Promise<Set<string>> {
  // Return cached result if available
  if (loginShellEnvCache) return loginShellEnvCache

  // Coalesce concurrent calls
  if (loginShellEnvPending) return loginShellEnvPending

  // R3-2 fix: hoist platform check out of the IIFE so the early return
  // doesn't race with the outer `loginShellEnvPending = …` assignment.
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') {
    // Windows doesn't have login-shell sourcing issues
    loginShellEnvCache = new Set<string>()
    return loginShellEnvCache
  }

  loginShellEnvPending = (async () => {
    const keys = new Set<string>()

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          shell,
          ['-ilc', 'printenv'],
          {
            encoding: 'utf-8',
            timeout: 5000,
            env: { ...process.env },
            windowsHide: true
          },
          (err, stdout) => {
            if (err) reject(err)
            else resolve(stdout)
          }
        )
      })

      for (const line of output.split('\n')) {
        const eqIdx = line.indexOf('=')
        if (eqIdx > 0) {
          const key = line.substring(0, eqIdx)
          if (key.length > 0) keys.add(key)
        }
      }
      pfLog.info(`[preflight] Login-shell env: captured ${keys.size} keys`)
    } catch (err) {
      pfLog.warn(`[preflight] Login-shell env capture failed (non-fatal): ${err}`)
    }

    loginShellEnvCache = keys
    loginShellEnvPending = null
    return keys
  })()

  return loginShellEnvPending
}

/** Reset login-shell cache (for testing). */
export function resetLoginShellCache(): void {
  loginShellEnvCache = null
  loginShellEnvPending = null
}

/**
 * Read currently set env vars from workspace .env + process.env + login shell.
 * Returns a Set of key names that have non-empty values.
 */
async function getAvailableEnvKeys(workspacePath: string): Promise<Set<string>> {
  const available = new Set<string>()

  // Process env
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length > 0) available.add(key)
  }

  // Login-shell env (A2a fix: macOS GUI-launched Electron)
  const loginShellKeys = await captureLoginShellEnv()
  for (const key of loginShellKeys) available.add(key)

  // Workspace .env
  const wsEnv = parseDotenvFile(join(workspacePath, '.env'))
  for (const [key, value] of wsEnv) {
    if (value.length > 0) available.add(key)
  }

  // Also check .env.local
  const localEnv = parseDotenvFile(join(workspacePath, '.env.local'))
  for (const [key, value] of localEnv) {
    if (value.length > 0) available.add(key)
  }

  return available
}

/**
 * Read all package.json dependencies (deps + devDeps) from the workspace.
 * Accepts pre-computed candidate dirs to avoid redundant fs walks (A11 fix).
 */
function getAllPackageDeps(candidates: string[]): Set<string> {
  const allDeps = new Set<string>()

  for (const dir of candidates) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const raw = readFileSync(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      for (const dep of Object.keys(pkg.dependencies ?? {})) allDeps.add(dep)
      for (const dep of Object.keys(pkg.devDependencies ?? {})) allDeps.add(dep)
    } catch {
      // Skip unparseable package.json
    }
  }

  return allDeps
}

// ── Async CLI probes (A1: replaces spawnSync, A7: adds cwd, A8: Windows shell) ──

interface ProbeResult {
  ok: boolean
  output: string
  timedOut?: boolean
}

/**
 * Run a single CLI probe asynchronously.
 * Returns { ok, output } — never throws.
 *
 * A7 fix: accepts `cwd` so probes like `supabase status` find project config.
 * A8 fix: uses `shell: true` on Windows for .cmd shim resolution.
 */
export function runProbeAsync(
  probe: { cmd: string; args: string[] },
  cwd?: string
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    try {
      const child = execFile(
        probe.cmd,
        probe.args,
        {
          encoding: 'utf-8',
          timeout: PROBE_BUDGET_MS,
          cwd: cwd || undefined,
          shell: process.platform === 'win32', // A8: .cmd shim resolution
          stdio: 'pipe',
          windowsHide: true
        } as Parameters<typeof execFile>[2],
        (err, stdout, _stderr) => {
          if (err) {
            const execErr = err as ExecFileException
            const isTimeout =
              execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
              execErr.message?.includes('ETIMEDOUT') ||
              execErr.killed
            resolve({
              ok: false,
              output: err.message || String(err),
              timedOut: isTimeout
            })
          } else {
            resolve({ ok: true, output: String(stdout || '').trim() })
          }
        }
      )
      // Ensure we don't leak if the child never calls back
      child.on('error', (err) => {
        resolve({ ok: false, output: err.message })
      })
    } catch (err) {
      resolve({ ok: false, output: String(err) })
    }
  })
}

/**
 * Legacy synchronous probe — kept for backward compatibility in tests.
 * Delegates to the same logic but synchronously via spawnSync.
 */
export function runProbe(probe: { cmd: string; args: string[] }): { ok: boolean; output: string } {
  try {
    const result = spawnSync(probe.cmd, probe.args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
      shell: process.platform === 'win32',
      windowsHide: true
    })
    if (result.error) {
      return { ok: false, output: result.error.message }
    }
    if (result.status !== 0) {
      return { ok: false, output: (result.stderr || '').trim() }
    }
    return { ok: true, output: (result.stdout || '').trim() }
  } catch (err) {
    return { ok: false, output: String(err) }
  }
}

// ── Detection: which services does this workspace need? ──

export interface DetectedService {
  def: PreflightServiceDef
  sources: PreflightDetectionSource[]
}

/**
 * Detect which external services/tools a workspace depends on.
 *
 * Merges three detection sources (G1, G10):
 * 1. Workspace scan (package deps + file markers) — backbone
 * 2. .env.example keys — map back to known services
 * 3. Blueprint task keyword scan — especially useful for greenfield
 *
 * A11 fix: hoists collectCandidateDirs to single pass (was called per-service).
 * LLM declarations are merged separately (Phase 4) via mergeChecks().
 */
export function detectRequiredServices(
  workspacePath: string,
  taskDescriptions: string[] = []
): DetectedService[] {
  // A11 fix: single fs walk, shared across getAllPackageDeps + file marker scan
  const candidates = collectCandidateDirs(workspacePath)
  const packageDeps = getAllPackageDeps(candidates)
  const envExampleKeys = readEnvExampleKeys(workspacePath)
  const detected = new Map<string, DetectedService>()

  // Pre-lowercase task descriptions once (was per-service)
  const lowerDescriptions = taskDescriptions.map((d) => d.toLowerCase())

  for (const svc of KNOWN_SERVICES) {
    const sources: PreflightDetectionSource[] = []

    // Source 1: package.json dependency patterns
    const hasPackageDep = svc.packagePatterns.some((pattern) => packageDeps.has(pattern))
    // Source 1b: file markers (uses hoisted candidates)
    const hasFileMarker = svc.fileMarkers.some((marker) =>
      candidates.some((dir) => existsSync(join(dir, marker)))
    )
    if (hasPackageDep || hasFileMarker) {
      sources.push('workspace-scan')
    }

    // Source 2: .env.example keys mapping
    const allServiceEnvVars = [...svc.requiredEnvVars, ...(svc.optionalEnvVars ?? [])]
    const hasEnvExample = allServiceEnvVars.some((envVar) => envExampleKeys.includes(envVar))
    if (hasEnvExample) {
      sources.push('env-example')
    }

    // Source 3: task keyword scan (G10: useful for greenfield)
    const hasTaskKeyword = svc.taskKeywords.some((kw) =>
      lowerDescriptions.some((desc) => desc.includes(kw.toLowerCase()))
    )
    if (hasTaskKeyword) {
      sources.push('task-keywords')
    }

    // Merge: any source is sufficient to flag the service
    if (sources.length > 0) {
      detected.set(svc.id, { def: svc, sources })
    }
  }

  return Array.from(detected.values())
}

// ── Check engine: run all checks for detected services ──

/**
 * Run preflight checks for a workspace — async with global 5s budget.
 *
 * Execution (A1 rewrite):
 * - All CLI probes run in parallel via Promise.allSettled under a global 5s budget
 * - Probes that don't finish within budget resolve as 'warn' (not blocker)
 * - Env var checks are synchronous (just Set lookups)
 * - Connectivity (liveness) failure = warn, not blocker (G8, premortem #3)
 * - CLI presence failure = blocker (unless presenceWarnOnly, e.g. psql)
 * - Results sorted: blockers first, then warnings, then passes
 */
export async function runPreflightChecks(
  workspacePath: string,
  taskDescriptions: string[] = []
): Promise<PreflightResult> {
  const detected = detectRequiredServices(workspacePath, taskDescriptions)
  const availableEnv = await getAvailableEnvKeys(workspacePath)
  const envExampleKeys = readEnvExampleKeys(workspacePath)
  const checks: PreflightCheck[] = []

  pfLog.info(
    `[preflight] Running checks for ${detected.length} detected services in ${workspacePath}`
  )

  // ── Phase 1: Collect all CLI probe promises ──
  interface ProbeJob {
    def: PreflightServiceDef
    sources: PreflightDetectionSource[]
    kind: 'presence' | 'liveness'
    promise: Promise<ProbeResult>
  }
  const probeJobs: ProbeJob[] = []

  for (const { def, sources } of detected) {
    if (def.presenceProbe) {
      probeJobs.push({
        def,
        sources,
        kind: 'presence',
        promise: runProbeAsync(def.presenceProbe, workspacePath)
      })
    }
  }

  // ── Phase 2: Run all probes in parallel with global budget ──
  const probeResults: Map<string, { presence?: ProbeResult; liveness?: ProbeResult }> = new Map()

  if (probeJobs.length > 0) {
    // R2-5 fix: store timer handle for explicit cleanup after probes settle
    let budgetTimerId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      budgetTimerId = setTimeout(() => resolve('timeout'), PROBE_BUDGET_MS)
    })

    // Race all presence probes against the budget
    try {
      const presencePromises = probeJobs.map(async (job) => {
        const result = await Promise.race([
          job.promise,
          timeoutPromise.then((): ProbeResult => ({
            ok: false,
            output: 'Global probe budget exceeded',
            timedOut: true
          }))
        ])
        const entry = probeResults.get(job.def.id) ?? {}
        // R2-6 fix: .then() always returns ProbeResult, never a string
        entry.presence = result
        probeResults.set(job.def.id, entry)
        return { def: job.def, sources: job.sources, result: entry.presence }
      })

      const presenceSettled = await Promise.allSettled(presencePromises)

      // Phase 3: For services with passing presence, run liveness probes in remaining budget
      const livenessJobs: ProbeJob[] = []
      for (const settled of presenceSettled) {
        if (settled.status === 'fulfilled') {
          const { def, sources, result } = settled.value
          if (result.ok && def.livenessProbe) {
            livenessJobs.push({
              def,
              sources,
              kind: 'liveness',
              promise: runProbeAsync(def.livenessProbe, workspacePath)
            })
          }
        }
      }

      if (livenessJobs.length > 0) {
        const livenessPromises = livenessJobs.map(async (job) => {
          const result = await Promise.race([
            job.promise,
            timeoutPromise.then((): ProbeResult => ({
              ok: false,
              output: 'Global probe budget exceeded',
              timedOut: true
            }))
          ])
          const entry = probeResults.get(job.def.id) ?? {}
          // R2-6 fix: same as above — .then() always returns ProbeResult
          entry.liveness = result
          probeResults.set(job.def.id, entry)
        })
        await Promise.allSettled(livenessPromises)
      }
    } finally {
      // R2-5 fix: clear the budget timer so it doesn't delay process exit
      if (budgetTimerId) clearTimeout(budgetTimerId)
    }
  }

  // ── Phase 4: Build check results from probe outcomes ──
  for (const { def, sources } of detected) {
    // CLI tool check
    if (def.presenceProbe) {
      const probeEntry = probeResults.get(def.id)
      const presence = probeEntry?.presence

      if (!presence || !presence.ok) {
        const isTimeout = presence?.timedOut
        const warnOnly = def.presenceWarnOnly || isTimeout
        checks.push({
          id: `${def.id}-cli`,
          name: `${def.name} CLI`,
          kind: 'cli-tool',
          status: warnOnly ? 'warn' : 'blocker',
          message: isTimeout
            ? `${def.name} CLI probe timed out (budget exceeded)`
            : `${def.name} CLI not found on PATH`,
          remediation: def.installHint,
          sources
        })
      } else {
        // Presence OK — check liveness result
        const liveness = probeEntry?.liveness
        if (def.livenessProbe && liveness && !liveness.ok) {
          // G8: Connectivity/liveness failure = warning, never hard blocker
          checks.push({
            id: `${def.id}-cli`,
            name: `${def.name} CLI`,
            kind: 'cli-tool',
            status: 'warn',
            message: liveness.timedOut
              ? `${def.name} liveness probe timed out`
              : `${def.name} CLI found but service not responding (${presence.output.substring(0, 80)})`,
            remediation: `Ensure ${def.name} service is running`,
            sources
          })
        } else {
          checks.push({
            id: `${def.id}-cli`,
            name: `${def.name} CLI`,
            kind: 'cli-tool',
            status: 'pass',
            message: `${def.name} CLI available: ${presence.output.substring(0, 80)}`,
            sources
          })
        }
      }
    }

    // ── Env var checks (B5: critical = blocker, optional = warn) ──
    for (const envVar of def.requiredEnvVars) {
      const isAvailable = availableEnv.has(envVar)
      // Alternative names satisfy the requirement (e.g. DB_READ_DSN/DB_WRITE_DSN
      // instead of DATABASE_URL) — any one present counts as configured.
      const presentAlts = (def.envVarAlternatives?.[envVar] ?? []).filter((alt) =>
        availableEnv.has(alt)
      )
      const satisfiedByAlts = !isAvailable && presentAlts.length > 0
      checks.push({
        id: envVar,
        name: envVar,
        kind: 'env-var',
        status: isAvailable || satisfiedByAlts ? 'pass' : 'blocker',
        message: isAvailable
          ? `${envVar} is set`
          : satisfiedByAlts
            ? `${envVar} not set, but ${presentAlts.join('/')} ${presentAlts.length === 1 ? 'is' : 'are'} — requirement satisfied`
            : `${envVar} is not set in process environment or workspace .env`,
        remediation: isAvailable
          ? undefined
          : satisfiedByAlts
            ? undefined
            : `Add ${envVar} to your .env file or set it in your environment`,
        sources
      })
    }

    // B5: Optional env vars → warn, not blocker
    for (const envVar of def.optionalEnvVars ?? []) {
      const isAvailable = availableEnv.has(envVar)
      checks.push({
        id: envVar,
        name: envVar,
        kind: 'env-var',
        status: isAvailable ? 'pass' : 'warn',
        message: isAvailable
          ? `${envVar} is set`
          : `${envVar} is not set (optional — some features may be limited)`,
        remediation: isAvailable ? undefined : `Add ${envVar} to your .env file if needed`,
        sources
      })
    }
  }

  // ── B8: .env.example first-class checks for keys not covered by registry ──
  const registryEnvVars = new Set<string>()
  for (const svc of KNOWN_SERVICES) {
    for (const v of svc.requiredEnvVars) registryEnvVars.add(v)
    for (const v of svc.optionalEnvVars ?? []) registryEnvVars.add(v)
  }
  for (const exampleKey of envExampleKeys) {
    if (registryEnvVars.has(exampleKey)) continue // Already handled by registry
    if (checks.some((c) => c.id === exampleKey)) continue // Already in results
    const isAvailable = availableEnv.has(exampleKey)
    if (!isAvailable) {
      checks.push({
        id: exampleKey,
        name: exampleKey,
        kind: 'env-var',
        status: 'warn', // B8: can't know criticality, so warn
        message: `${exampleKey} is listed in .env.example but not set`,
        remediation: `Add ${exampleKey} to your .env file`,
        sources: ['env-example']
      })
    }
  }

  // Sort: blockers first, then warnings, then passes
  const statusOrder: Record<PreflightCheckStatus, number> = { blocker: 0, warn: 1, pass: 2 }
  checks.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])

  const result: PreflightResult = {
    checks,
    ranAt: new Date().toISOString(),
    hasBlockers: checks.some((c) => c.status === 'blocker'),
    hasWarnings: checks.some((c) => c.status === 'warn')
  }

  pfLog.info(
    `[preflight] Complete: ${checks.length} checks — ` +
      `${checks.filter((c) => c.status === 'blocker').length} blockers, ` +
      `${checks.filter((c) => c.status === 'warn').length} warnings, ` +
      `${checks.filter((c) => c.status === 'pass').length} passes`
  )

  return result
}

/**
 * Merge LLM-declared dependencies into existing checks (Phase 4, additive only).
 * De-duplicates by check ID — existing deterministic checks take precedence.
 */
export function mergeChecks(
  existing: PreflightCheck[],
  additional: PreflightCheck[]
): PreflightCheck[] {
  const byId = new Map<string, PreflightCheck>()
  for (const check of existing) byId.set(check.id, check)
  for (const check of additional) {
    if (!byId.has(check.id)) {
      byId.set(check.id, check)
    } else {
      // Merge sources but keep existing check's status/message
      const prev = byId.get(check.id)!
      const mergedSources = new Set([...prev.sources, ...check.sources])
      byId.set(check.id, { ...prev, sources: Array.from(mergedSources) })
    }
  }
  return Array.from(byId.values())
}

/**
 * Build discovery strings from unresolved preflight blockers for injection
 * into build task context (G11: turn failures into agent guidance).
 *
 * D11: Only blockers are injected as discoveries (warns excluded to avoid
 * crowding the 20-cap discovery slot and evicting verify-gap remediation).
 *
 * Example output:
 * "[PREFLIGHT] SUPABASE_URL unavailable — do not attempt live DB operations;
 *  write migrations/config only, mark task partial"
 */
export function buildPreflightDiscoveries(result: PreflightResult): string[] {
  const discoveries: string[] = []

  for (const check of result.checks) {
    if (check.status === 'blocker') {
      const guidance =
        check.kind === 'env-var'
          ? `do not attempt operations requiring ${check.name}; write config/stubs only, mark task partial`
          : check.kind === 'cli-tool'
            ? `${check.name} is unavailable — skip commands that require it, document what was skipped`
            : `${check.name} is not reachable — avoid live service calls, use mocks/stubs`
      discoveries.push(`[PREFLIGHT] ${check.name} unavailable — ${guidance}`)
    }
    // D11: Warnings no longer injected into discoveries to prevent crowding verify gaps
  }

  return discoveries
}

// ── Gate command detection (M1.2) ──

/** Depth of the walk that looks for .NET project files. Root + two levels. */
const DOTNET_SCAN_DEPTH = 2
/** Hard cap so a monorepo with hundreds of projects cannot stall the scan. */
const DOTNET_SCAN_LIMIT = 40

const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'dist',
  'out',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__'
])

function readIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : undefined
  } catch {
    return undefined
  }
}

/** Collect `*.sln` / `*.csproj` paths relative to the workspace root. */
function findDotnetProjects(root: string): string[] {
  const found: string[] = []

  const walk = (dir: string, relative: string, depth: number): void => {
    if (found.length >= DOTNET_SCAN_LIMIT) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= DOTNET_SCAN_LIMIT) return
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.sln') || lower.endsWith('.csproj')) found.push(rel)
      } else if (entry.isDirectory() && depth < DOTNET_SCAN_DEPTH) {
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(join(dir, entry.name), rel, depth + 1)
      }
    }
  }

  walk(root, '', 0)
  return found
}

/**
 * Read the workspace's toolchain manifests into the pure detector's input shape.
 *
 * All I/O lives here so `detectGateCommands` stays a pure function over a
 * snapshot — the whole detection matrix is then testable without a fixture repo.
 */
export function readWorkspaceManifests(workspacePath: string): WorkspaceManifests {
  let rootEntries: string[] = []
  try {
    rootEntries = readdirSync(workspacePath)
  } catch {
    return {}
  }
  const present = new Set(rootEntries)

  return {
    packageJson: readIfExists(join(workspacePath, 'package.json')),
    lockfiles: rootEntries.filter((f) =>
      ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].includes(f)
    ),
    dotnetProjects: findDotnetProjects(workspacePath),
    cargoToml: readIfExists(join(workspacePath, 'Cargo.toml')),
    pyprojectToml: readIfExists(join(workspacePath, 'pyproject.toml')),
    hasPytestConfig:
      present.has('pytest.ini') || present.has('tox.ini') || present.has('setup.cfg'),
    goMod: readIfExists(join(workspacePath, 'go.mod'))
  }
}

/**
 * Detect the workspace's gate commands from what is on disk.
 *
 * This is the LOWEST-precedence source. A blank workspace legitimately detects
 * nothing — the affected gates then report `unverifiable`, which is the honest
 * verdict while the toolchain does not yet exist.
 */
export function scanGateCommands(workspacePath: string): GateCommandSet {
  try {
    return detectGateCommands(readWorkspaceManifests(workspacePath))
  } catch (err) {
    pfLog.warn('[scanGateCommands] Detection failed — gates will report unverifiable', err)
    return {}
  }
}

// ── Singleton export (follows codebase convention) ──

export const blueprintPreflightService = {
  runChecks: runPreflightChecks,
  detectServices: detectRequiredServices,
  buildDiscoveries: buildPreflightDiscoveries,
  mergeChecks,
  scanGateCommands,
  readWorkspaceManifests
}

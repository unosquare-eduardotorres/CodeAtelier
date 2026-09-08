/**
 * Blueprint Environment Preflight — shared types between main and renderer.
 *
 * Preflight validates external dependencies (CLI tools, env vars/secrets,
 * service connectivity) before the BUILD phase starts. Checks are deterministic
 * (workspace scan + spawnSync probes) with LLM declarations as additive input.
 *
 * Security: results carry key **names** only, never secret values.
 */

// ── Check kinds ──

/** What type of external dependency is being checked. */
export type PreflightCheckKind = 'cli-tool' | 'env-var' | 'service'

/** Result status for a single preflight check. */
export type PreflightCheckStatus = 'pass' | 'warn' | 'blocker'

/** Where the dependency was detected from. */
export type PreflightDetectionSource =
  | 'workspace-scan' // tech-stack-detector / file markers
  | 'env-example' // .env.example keys
  | 'task-keywords' // keyword scan on blueprint task descriptions
  | 'llm-declaration' // LLM-declared externalDependencies in plan artifact

// ── Single check result ──

export interface PreflightCheck {
  /** Stable ID for de-duplication (e.g. 'supabase', 'docker', 'STRIPE_SECRET_KEY'). */
  id: string
  /** Human-readable name (e.g. 'Supabase CLI', 'Docker', 'STRIPE_SECRET_KEY'). */
  name: string
  kind: PreflightCheckKind
  status: PreflightCheckStatus
  /** Short explanation of the result (e.g. 'docker v27.1.2 found', 'SUPABASE_URL not set'). */
  message: string
  /** Actionable remediation hint (e.g. 'brew install supabase/tap/supabase'). */
  remediation?: string
  /** Which detection source(s) identified this dependency. */
  sources: PreflightDetectionSource[]
}

// ── Aggregate result ──

export interface PreflightResult {
  /** All individual checks, ordered: blockers first, then warnings, then passes. */
  checks: PreflightCheck[]
  /** ISO timestamp when the checks were executed. */
  ranAt: string
  /** True if any check has status === 'blocker'. */
  hasBlockers: boolean
  /** True if any check has status === 'warn'. */
  hasWarnings: boolean
}

// ── Service registry entry (used by the check engine) ──

export interface PreflightServiceDef {
  /** Stable service ID (matches PreflightCheck.id). */
  id: string
  /** Human-readable name. */
  name: string
  /** Package dependency patterns that indicate this service (checked in package.json). */
  packagePatterns: string[]
  /** File/directory markers that indicate this service. */
  fileMarkers: string[]
  /** Keywords in blueprint task descriptions that suggest this service. */
  taskKeywords: string[]
  /** Environment variable names this service requires — absence = blocker. */
  requiredEnvVars: string[]
  /**
   * Alternative env-var names that satisfy a required var — presence of ANY
   * listed alternative marks the requirement met (e.g. a project using
   * DB_READ_DSN/DB_WRITE_DSN instead of the generic DATABASE_URL).
   * Keyed by the required var name; each entry lists acceptable substitutes.
   */
  envVarAlternatives?: Record<string, string[]>
  /** Environment variables that are useful but not critical — absence = warn. */
  optionalEnvVars?: string[]
  /** Presence probe: CLI command + args to check installation (e.g. ['docker', '--version']). */
  presenceProbe?: { cmd: string; args: string[] }
  /** If true, CLI presence failure is a warning rather than a blocker (e.g. psql for hosted DBs). */
  presenceWarnOnly?: boolean
  /** Liveness probe: deeper check that the service is actually running (e.g. ['docker', 'info']). */
  livenessProbe?: { cmd: string; args: string[] }
  /**
   * Reachability probe: open a TCP connection to the host named by a DSN.
   *
   * The gap this closes: `psql --version` proves a CLI is installed, not that a
   * database exists. A workspace whose DATABASE_URL points at a dead host passed
   * preflight completely clean — every task that touched the DB then failed at
   * BUILD for a reason preflight already had the information to predict.
   */
  connectivityProbe?: {
    /** Env vars whose VALUE is a DSN. The first one that parses is probed. */
    dsnEnvVars: string[]
    /** Port to use when the DSN omits one. */
    defaultPort: number
  }
  /** Human-readable install/setup hint. */
  installHint: string
}

// ── Connectivity targets (G2) ──

/**
 * A TCP endpoint to probe. Host and port ONLY — by the time a value reaches this
 * shape the credentials in the DSN have already been discarded, which is what
 * lets the resulting check message be shown to the user and written to the
 * REVIEW artifact under the “names only, never values” rule at the top of this
 * file.
 */
export interface ConnectivityTarget {
  host: string
  port: number
}

/**
 * Derive `host:port` from a DSN, discarding everything else.
 *
 * Pure and total — returns null rather than throwing, because an unparseable
 * connection string is a reason to skip the probe, not to fail preflight.
 *
 * Deliberately returns null for:
 *   - `mongodb+srv://` — the real hosts come from a DNS SRV lookup, so probing
 *     the seed name on 27017 would report a false outage;
 *   - hosts with no hostname at all (unix sockets, bare paths);
 *   - anything whose port is not a valid TCP port;
 *   - values that are not plausibly a host — without this the bare-host branch
 *     below would happily accept a sentence as a hostname and then report the
 *     resulting DNS failure as an infrastructure outage.
 *
 * Accepts both full URLs and bare `host:port` / `host` forms, since
 * `REDIS_URL=cache.internal:6379` is a shape people really write.
 */
export function parseDsnTarget(dsn: string, defaultPort: number): ConnectivityTarget | null {
  const raw = dsn.trim()
  if (!raw) return null

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
  if (schemeMatch) {
    // SRV seed names resolve to a different host set; probing this one lies.
    if (schemeMatch[1].toLowerCase().endsWith('+srv')) return null
    try {
      const url = new URL(raw)
      // `url.hostname` never contains the userinfo section, so credentials are
      // dropped here rather than sanitised later.
      const host = stripBrackets(url.hostname)
      if (!host) return null
      const port = url.port ? Number(url.port) : defaultPort
      return isValidPort(port) ? { host, port } : null
    } catch {
      return null
    }
  }

  // Bare `host:port` or `host`. A '@' means someone wrote credentials without a
  // scheme; keep only what follows it.
  const afterAuth = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw
  const cleaned = afterAuth.split('/')[0].split('?')[0]
  if (!cleaned) return null

  const lastColon = cleaned.lastIndexOf(':')
  // No colon, or a colon inside an unbracketed IPv6 literal — treat as host only.
  if (lastColon < 1 || cleaned.slice(lastColon + 1).includes(':')) {
    const hostOnly = stripBrackets(cleaned)
    if (!isPlausibleHost(hostOnly)) return null
    return isValidPort(defaultPort) ? { host: hostOnly, port: defaultPort } : null
  }

  const host = stripBrackets(cleaned.slice(0, lastColon))
  const port = Number(cleaned.slice(lastColon + 1))
  if (!isPlausibleHost(host)) return null
  return isValidPort(port) ? { host, port } : null
}

/** Hostname, IPv4, or IPv6 literal — nothing else is worth a TCP probe. */
function isPlausibleHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.includes(':')) return /^[0-9a-f:.]+$/i.test(host) // IPv6 literal
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(host)
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

// ── Verification-depth readiness (U3) ──

/**
 * The cheapest possible early warning for the depth ladder: the user asked for
 * a level of proof, and the command that produces it does not resolve.
 *
 * Surfaced through preflight because the approval gate already renders preflight
 * and it is the last human decision point BEFORE the build burns. Discovering
 * the same fact at VERIFY costs the whole run and yields a blueprint that
 * finishes "complete-unproven" — honest, but far too late to act on.
 *
 * Severity, and why the two cases differ:
 *
 *   - depth `e2e` with no e2e command is a `blocker`. The user explicitly asked
 *     for end-to-end proof and the pipeline has no way to produce ANY. Nothing
 *     downstream will change that, so the fact is fully known here.
 *   - depth `integration`/`e2e` with no smoke command stays a `warn` — the
 *     stronger e2e gate may still cover the boot path.
 *
 * `blocker` does NOT stop the build. Preflight blockers are informational in the
 * approval gate: they colour the header red and re-label Approve as “Build
 * Anyway”, but the button stays enabled (BlueprintApprovalGate.tsx:775-796).
 * That preserves the doctrine that a missing command is an environment fact and
 * never a hard failure, while making the strongest depth impossible to walk past
 * by accident.
 */
export function verificationDepthPreflightCheck(
  depth: 'standard' | 'integration' | 'e2e',
  resolved: { smoke: boolean; e2e: boolean }
): PreflightCheck | null {
  if (depth === 'e2e' && !resolved.e2e) {
    return {
      id: 'verification-depth-e2e',
      name: 'End-to-end command',
      kind: 'cli-tool',
      status: 'blocker',
      message:
        'Verification depth is “End-to-end” but no e2e command resolved — the ' +
        'end-to-end gate will report as unproven and nothing will check that a ' +
        'real user path works.',
      remediation:
        'Declare an `e2e` command in the plan’s gate-commands block, or set one ' +
        'under Workspace Settings → Repository → Gate commands.',
      sources: ['workspace-scan']
    }
  }
  if ((depth === 'integration' || depth === 'e2e') && !resolved.smoke) {
    return {
      id: 'verification-depth-smoke',
      name: 'Smoke command',
      kind: 'cli-tool',
      status: 'warn',
      message:
        `Verification depth is “${depth}” but no smoke command resolved — nothing ` +
        'will check that the app actually boots.',
      remediation:
        'Declare a `smoke` command in the plan’s gate-commands block, or set one ' +
        'under Workspace Settings → Repository → Gate commands.',
      sources: ['workspace-scan']
    }
  }
  return null
}

// ── IPC payloads ──

export interface PreflightRunPayload {
  blueprintId: string
  workspaceId: string
}

export interface PreflightResultPayload {
  blueprintId: string
  workspaceId: string
  result: PreflightResult
}

// ── Extended approval payload (adds optional preflight to existing type) ──

/**
 * Preflight data attached to the BlueprintApprovalNeededPayload.
 * This is an optional field — absent when preflight hasn't run yet.
 */
export interface ApprovalPreflightData {
  result: PreflightResult
  /** True if the user overrode blockers to proceed. */
  overridden: boolean
}

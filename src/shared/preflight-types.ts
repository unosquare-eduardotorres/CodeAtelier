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
  /** Environment variables that are useful but not critical — absence = warn. */
  optionalEnvVars?: string[]
  /** Presence probe: CLI command + args to check installation (e.g. ['docker', '--version']). */
  presenceProbe?: { cmd: string; args: string[] }
  /** If true, CLI presence failure is a warning rather than a blocker (e.g. psql for hosted DBs). */
  presenceWarnOnly?: boolean
  /** Liveness probe: deeper check that the service is actually running (e.g. ['docker', 'info']). */
  livenessProbe?: { cmd: string; args: string[] }
  /** Human-readable install/setup hint. */
  installHint: string
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

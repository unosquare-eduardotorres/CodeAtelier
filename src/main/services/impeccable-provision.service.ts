/**
 * Impeccable skill provisioning.
 *
 * The npm tarball contains NO skill markdown — it ships only the launcher shim
 * and, via optional dependencies, the engine binary. The prose the design audit
 * needs (SKILL.md + 35 per-command reference playbooks) is materialised by the
 * engine's own `install` subcommand, which writes into whatever directory it is
 * run from.
 *
 * We therefore run `install` once into an **app-managed directory under
 * userData** and read the markdown from there. We deliberately do NOT install
 * into the user's workspace `.claude/skills/`: that would mutate their repo and
 * dirty their git status without consent (decision Q12).
 *
 * ── Containment: why we plant a `.git` marker ────────────────────────────
 * `install --scope=project` does NOT install into its cwd — it walks UP from
 * cwd to the nearest `.git` and installs into that repository root. Verified
 * against engine v0.1.3: running from `<repo>/nested/deep` wrote to
 * `<repo>/.claude`. Setting `cwd` alone is therefore not containment, and this
 * bit us during development by writing into this very repo.
 *
 * An empty `.git` directory at the provision root stops that walk, so the
 * payload always lands exactly where we expect. This matters in dev (where the
 * fallback root sits inside this repo) and protects the real userData path too
 * — users with a dotfiles repo at `$HOME` would otherwise have
 * `~/Library/Application Support/...` resolve to `$HOME`.
 *
 * Provisioning is lazy — nothing runs at app startup. The first design run or
 * wizard open triggers it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skillLogger } from '../logger'
import {
  IMPECCABLE_ENGINE_VERSION,
  IMPECCABLE_PACKAGE_VERSION,
  checkAvailability,
  runEngine
} from './impeccable-runtime.service'

/** Never let a logging call break provisioning — see the note in impeccable-runtime.service.ts. */
const log = {
  info: (msg: string): void => skillLogger?.info?.(msg),
  warn: (msg: string): void => skillLogger?.warn?.(msg)
}

/** `install` downloads the skill payload, so it needs a generous budget. */
const INSTALL_TIMEOUT_MS = 60_000

/**
 * How long a failed provision is remembered before we try again.
 *
 * `install` DOWNLOADS its payload, so offline is the expected first-run failure,
 * not an edge case — and each attempt burns the full 60 s timeout. Without a
 * cooldown, repeatedly opening the wizard while offline stacks 60 s stalls.
 * Callers that want to retry now pass `{ force: true }`.
 */
const FAILURE_COOLDOWN_MS = 60_000

const STAMP_FILENAME = '.provision-stamp.json'

/**
 * Path `impeccable install --scope=project` creates, relative to its cwd.
 * Verified against engine v0.1.3.
 */
const SKILL_SUBPATH = join('.claude', 'skills', 'impeccable')

export type ProvisionStatus = 'ready' | 'unavailable' | 'failed'

export interface ProvisionResult {
  status: ProvisionStatus
  skillDir?: string
  reason?: string
}

interface ProvisionStamp {
  engineVersion: string
  pkgVersion: string
  installedAt: string
}

let rootOverride: string | null = null

/** Test seam — redirect provisioning away from the real userData directory. */
export function __setProvisionRootForTests(root: string | null): void {
  rootOverride = root
  inFlight = undefined
  lastFailure = undefined
  markdownCache.clear()
}

/**
 * App-managed provisioning root. Never inside a user workspace.
 *
 * Same defensive electron load as the runtime resolver — `electron` is
 * unresolvable in unit tests and scripts.
 */
export function getProvisionRoot(): string {
  if (rootOverride) return rootOverride
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- defensive lazy load; electron may be unavailable in non-app contexts
    const { app } = require('electron')
    return join(app.getPath('userData'), 'impeccable-skill')
  } catch {
    return join(process.cwd(), '.impeccable-skill')
  }
}

/** Directory containing SKILL.md once provisioned. */
export function getSkillDir(): string {
  return join(getProvisionRoot(), SKILL_SUBPATH)
}

function readStamp(root: string): ProvisionStamp | null {
  try {
    const raw = readFileSync(join(root, STAMP_FILENAME), 'utf-8')
    const parsed = JSON.parse(raw) as ProvisionStamp
    if (typeof parsed?.engineVersion !== 'string' || typeof parsed?.pkgVersion !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeStamp(root: string): void {
  const stamp: ProvisionStamp = {
    engineVersion: IMPECCABLE_ENGINE_VERSION,
    pkgVersion: IMPECCABLE_PACKAGE_VERSION,
    installedAt: new Date().toISOString()
  }
  try {
    writeFileSync(join(root, STAMP_FILENAME), JSON.stringify(stamp, null, 2), 'utf-8')
  } catch (err) {
    // A missing stamp only costs us a redundant reinstall next time.
    log.warn(`[impeccable] could not write provision stamp: ${String(err)}`)
  }
}

/** True when the on-disk payload matches the pinned versions and SKILL.md exists. */
function isProvisioned(root: string): boolean {
  const stamp = readStamp(root)
  if (!stamp) return false
  if (stamp.engineVersion !== IMPECCABLE_ENGINE_VERSION) return false
  if (stamp.pkgVersion !== IMPECCABLE_PACKAGE_VERSION) return false
  return existsSync(join(root, SKILL_SUBPATH, 'SKILL.md'))
}

/**
 * Cheap synchronous status — safe to call from IPC/UI without triggering an
 * install.
 */
export function getProvisionState(): { provisioned: boolean; skillDir: string } {
  const root = getProvisionRoot()
  return { provisioned: isProvisioned(root), skillDir: join(root, SKILL_SUBPATH) }
}

let inFlight: Promise<ProvisionResult> | undefined
let lastFailure: { result: ProvisionResult; at: number } | undefined

/** Whether a previous failure is still inside its cooldown window. */
export function getProvisionCooldownRemainingMs(): number {
  if (!lastFailure) return 0
  return Math.max(0, FAILURE_COOLDOWN_MS - (Date.now() - lastFailure.at))
}

/**
 * Ensure the skill markdown exists on disk, installing it if needed.
 *
 * Fast path (stamp matches) does no subprocess work. Concurrent callers share a
 * single in-flight install so two runs can never race into the same directory.
 * A recent failure short-circuits for `FAILURE_COOLDOWN_MS` — pass
 * `{ force: true }` to bypass it, which is what an explicit "retry" does.
 * Never throws.
 */
export function ensureProvisioned(options: { force?: boolean } = {}): Promise<ProvisionResult> {
  const root = getProvisionRoot()

  if (isProvisioned(root)) {
    lastFailure = undefined
    return Promise.resolve({ status: 'ready', skillDir: join(root, SKILL_SUBPATH) })
  }
  if (options.force) lastFailure = undefined
  if (inFlight) return inFlight

  const cooldownMs = getProvisionCooldownRemainingMs()
  if (cooldownMs > 0 && lastFailure) {
    log.info(
      `[impeccable] provisioning suppressed for another ${Math.ceil(cooldownMs / 1000)}s ` +
        `after: ${lastFailure.result.reason}`
    )
    return Promise.resolve(lastFailure.result)
  }

  inFlight = (async (): Promise<ProvisionResult> => {
    // A forced retry must re-probe too: "engine unavailable" is itself cached.
    const availability = await checkAvailability({ force: options.force })
    if (!availability.available) {
      return { status: 'unavailable', reason: availability.reason ?? 'engine unavailable' }
    }

    try {
      mkdirSync(root, { recursive: true })
      // Containment marker — see the header note. Must exist BEFORE `install`
      // runs, or the payload escapes to the nearest enclosing repository.
      mkdirSync(join(root, '.git'), { recursive: true })
    } catch (err) {
      return { status: 'failed', reason: `cannot create ${root}: ${String(err)}` }
    }

    log.info(`[impeccable] provisioning skill payload into ${root}`)

    // `-y` suppresses the interactive confirmation; `--no-hooks` keeps
    // Impeccable's edit-time design hooks out of our agent sessions (explicitly
    // out of scope); `--force` makes a version-bump reinstall overwrite a stale
    // payload instead of refusing.
    const result = await runEngine(
      ['install', '--providers=claude', '--scope=project', '--no-hooks', '--force', '-y'],
      { cwd: root, timeoutMs: INSTALL_TIMEOUT_MS }
    )

    if (result.timedOut) {
      return { status: 'failed', reason: 'install timed out' }
    }
    if (result.error) {
      return { status: 'failed', reason: result.error }
    }
    if (result.code !== 0) {
      return {
        status: 'failed',
        reason: `install exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`
      }
    }

    const skillDir = join(root, SKILL_SUBPATH)
    if (!existsSync(join(skillDir, 'SKILL.md'))) {
      // `install` downloads its payload; a network failure can still exit 0.
      return { status: 'failed', reason: 'install completed but SKILL.md is missing' }
    }

    writeStamp(root)
    markdownCache.clear()
    log.info(`[impeccable] skill payload ready at ${skillDir}`)
    return { status: 'ready', skillDir }
  })()
    .catch((err): ProvisionResult => ({
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err)
    }))
    .then((res) => {
      inFlight = undefined
      if (res.status === 'ready') {
        lastFailure = undefined
      } else {
        lastFailure = { result: res, at: Date.now() }
        log.warn(`[impeccable] provisioning ${res.status}: ${res.reason}`)
      }
      return res
    })

  return inFlight
}

// ── Markdown reads (the seam prompt assembly consumes) ───────────────────────

const markdownCache = new Map<string, { content: string; mtimeMs: number }>()

/**
 * mtime-cached file read, mirroring `SkillPromptComposer`'s cache: re-read only
 * when the file actually changes.
 */
function readCached(path: string): { path: string; content: string } | null {
  try {
    const { mtimeMs } = statSync(path)
    const hit = markdownCache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return { path, content: hit.content }
    const content = readFileSync(path, 'utf-8')
    markdownCache.set(path, { content, mtimeMs })
    return { path, content }
  } catch {
    return null
  }
}

/** The top-level Impeccable SKILL.md (~11.7 KB). `null` when not provisioned. */
export function readSkillMarkdown(): { path: string; content: string } | null {
  return readCached(join(getSkillDir(), 'SKILL.md'))
}

/**
 * A single command playbook, e.g. `reference/critique.md`. Sizes vary widely
 * (audit ~7.9 KB, critique ~42.7 KB) — callers must budget before injecting.
 */
export function readCommandMarkdown(commandId: string): { path: string; content: string } | null {
  // Defensive: commandId feeds a path segment; keep it a bare slug.
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(commandId)) return null
  return readCached(join(getSkillDir(), 'reference', `${commandId}.md`))
}

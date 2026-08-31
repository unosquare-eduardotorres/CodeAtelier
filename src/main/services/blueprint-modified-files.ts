/**
 * Blueprint modified-files tracking — records a baseline commit at BUILD start
 * and answers "which files changed since then" for the VERIFY deliverable.
 *
 * The baseline is stored on the blueprint run's metadata so it survives process
 * restarts; the diff is computed lazily on request, never during the build.
 *
 * All git calls are async (promisified execFile) — a slow or hung git on a
 * large repo must never block the main thread's IPC handling.
 */
import { execFile as execFileCb } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import log from 'electron-log'

const logger = log.scope('blueprint-modified-files')

const execFile = promisify(execFileCb)

export interface ModifiedFileEntry {
  path: string
  /** 'M' modified, 'A' added, 'D' deleted */
  status: 'M' | 'A' | 'D'
  additions: number
  deletions: number
}

/**
 * Run git in the repo. Returns stdout on success (possibly empty — no changes),
 * null on any failure. The distinction matters: empty means "nothing changed",
 * null means "git unavailable / bad baseline" and callers fall back.
 */
async function git(repoPath: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000
    })
    return stdout
  } catch {
    return null
  }
}

/** Current HEAD sha, or null when the path is not a git repo / has no commits. */
export async function getHeadCommit(repoPath: string): Promise<string | null> {
  const sha = ((await git(repoPath, 'rev-parse', 'HEAD')) ?? '').trim()
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
}

/** Line count for numstat purposes — 0 for empty/unreadable content. */
function countLines(content: string): number {
  if (content === '') return 0
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length
}

/** Untracked line counting reads disk synchronously on the main thread — cap it. */
const MAX_UNTRACKED_COUNT_BYTES = 1024 * 1024

/**
 * Files changed between the baseline commit and the working tree, with
 * numstat counts. Returns null when git or the baseline is unavailable —
 * callers fall back to aggregating tool activities.
 *
 * Untracked files are appended as additions: `git diff <commit>` only sees
 * tracked paths, and new files the BUILD created but never staged are exactly
 * the output VERIFY exists to report.
 */
export async function getModifiedFilesSince(
  repoPath: string,
  baselineCommit: string
): Promise<ModifiedFileEntry[] | null> {
  if (!/^[0-9a-f]{7,40}$/.test(baselineCommit)) return null

  // name-status: one "STATUS\tpath" per line (renames: "R100\told\tnew" — we
  // keep the new path and treat it as modified; the old path shows as D).
  const statusOut = await git(repoPath, 'diff', '--name-status', '--no-color', baselineCommit)
  if (statusOut === null) return null
  const statusByPath = new Map<string, 'M' | 'A' | 'D'>()
  for (const line of statusOut.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    const path = parts[parts.length - 1] // rename lines: last field is the new path
    if (!path) continue
    const kind: 'M' | 'A' | 'D' = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M' // R/C/anything else → M
    statusByPath.set(path, kind)
  }

  // Untracked (new, never staged) files — invisible to git diff, counted as
  // pure additions from disk. ls-files failure alongside a successful diff is
  // treated as "no untracked" rather than killing the whole listing.
  const untrackedOut = await git(repoPath, 'ls-files', '--others', '--exclude-standard')
  for (const p of (untrackedOut ?? '').split('\n')) {
    if (p) statusByPath.set(p, 'A')
  }

  if (statusByPath.size === 0) return []

  // numstat: "adds\tdels\tpath" — binary files show "-\t-".
  const numstatOut = await git(repoPath, 'diff', '--numstat', '--no-color', baselineCommit)
  const statsByPath = new Map<string, { additions: number; deletions: number }>()
  for (const line of (numstatOut ?? '').split('\n')) {
    if (!line) continue
    const [adds, dels, path] = line.split('\t')
    if (!path) continue
    statsByPath.set(path, {
      additions: /^\d+$/.test(adds) ? parseInt(adds, 10) : 0,
      deletions: /^\d+$/.test(dels) ? parseInt(dels, 10) : 0
    })
  }

  const entries: ModifiedFileEntry[] = []
  for (const [path, status] of statusByPath) {
    let stats = statsByPath.get(path)
    if (!stats && status === 'A') {
      // Untracked file — count its lines from disk (best-effort). Size-guarded:
      // a large untracked artifact (un-ignored binary, generated bundle) must
      // never block the main process on a sync read, and its garbage-utf8 line
      // count would be noise anyway — the path still lists as 'A' with 0/0.
      try {
        const size = statSync(join(repoPath, path)).size
        stats =
          size > MAX_UNTRACKED_COUNT_BYTES
            ? { additions: 0, deletions: 0 }
            : { additions: countLines(readFileSync(join(repoPath, path), 'utf8')), deletions: 0 }
      } catch {
        stats = { additions: 0, deletions: 0 }
      }
    }
    entries.push({ path, status, ...(stats ?? { additions: 0, deletions: 0 }) })
  }
  // Sort by churn (adds+dels) descending — biggest changes first.
  entries.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  return entries
}

/** Record the baseline for a blueprint run — best-effort, never throws. */
export async function recordBaselineCommit(
  blueprintId: string,
  repoPath: string,
  persist: (blueprintId: string, key: string, value: string) => void
): Promise<void> {
  try {
    const sha = await getHeadCommit(repoPath)
    if (sha) persist(blueprintId, 'baselineCommit', sha)
  } catch (err) {
    logger.warn(`[recordBaselineCommit] failed for ${blueprintId}:`, err)
  }
}

import { readFile } from 'node:fs/promises'
import { extname, resolve, relative } from 'node:path'
import simpleGit from 'simple-git'
import type { RepoInfo, FileDiffResult, DiffIdenticalReason } from '../../shared/types'
import { COMMIT_ATTRIBUTION } from '../../shared/constants'
import log from 'electron-log'

const logger = log.scope('Repo')

/** Map file extensions to Prism language identifiers */
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.vue': 'markup',
  '.xml': 'xml',
  '.svg': 'xml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'bash',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.prisma': 'graphql',
  '.dockerfile': 'docker',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin'
}

/**
 * Ensure filePath resolves within repoPath — prevents path traversal attacks.
 * Throws if the resolved path escapes the repo root (e.g. ../../etc/passwd).
 */
export function assertWithinRepo(repoPath: string, filePath: string): string {
  const absoluteRepo = resolve(repoPath)
  const absoluteFile = resolve(repoPath, filePath)
  const rel = relative(absoluteRepo, absoluteFile)
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Path traversal denied: ${filePath}`)
  }
  return absoluteFile
}

/** Append the Code Atelier attribution trailer to a commit message. */
function appendAttribution(message: string): string {
  if (message.includes(COMMIT_ATTRIBUTION)) return message
  return `${message}\n\n${COMMIT_ATTRIBUTION}`
}

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  // Handle Dockerfile without extension
  if (filePath.toLowerCase().endsWith('dockerfile')) return 'docker'
  return EXT_TO_LANGUAGE[ext] ?? 'text'
}

/**
 * `git show <ref>:<path>` failing because the path isn't present in that ref is
 * EXPECTED (new or deleted file) — everything else is a real failure worth surfacing.
 */
export function isMissingPathError(msg: string): boolean {
  return /does not exist in|exists on disk, but not in/i.test(msg)
}

/**
 * Decide whether a failed `git show <ref>:<path>` deserves a user-visible warning.
 * A repo with no commits has no HEAD, so EVERY `git show HEAD:<path>` fails with
 * "ambiguous argument 'HEAD'" — warning there would paint an error banner on every
 * file of a fresh workspace. Widening isMissingPathError instead would also silence
 * the genuine unfetched-`origin/master` failure, so the check stays here.
 */
export function shouldWarnOnShowFailure(baseExists: boolean, msg: string): boolean {
  if (!baseExists) return false
  return !isMissingPathError(msg)
}

/** First line of an error message — git errors are multi-line and noisy. */
function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const line = msg.split('\n').find((l) => l.trim().length > 0)
  return line?.trim() ?? 'Unknown git error'
}

/** Detect binary content by checking for null bytes in the first 8KB */
function isBinaryContent(s: string): boolean {
  if (s.length === 0) return false
  // Skip UTF-16 BOM — these are text files, not binary
  const start = s.charCodeAt(0) === 0xFEFF ? 1 : 0
  return s.slice(start, start + 8000).includes('\0')
}

export interface FileDetailEntry {
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  staged: boolean
  /** Source path of a rename/copy — the old side must be looked up there, not at filePath. */
  oldPath?: string
}

/** One record of `git diff --name-status -z` output. */
export interface NameStatusEntry {
  /** Full status token — 'M', 'A', 'D', 'R100', 'C75'… */
  status: string
  /** Destination path (the path as it exists on the new side). */
  filePath: string
  /** Source path, present only for renames and copies. */
  oldPath?: string
}

/**
 * Parse `git diff --name-status -z` output.
 * `core.quotePath` defaults to true, so the tab-separated form mangles any
 * non-ASCII path into `"Solutions/Caf\303\251.cs"` — every later lookup for that
 * path then fails silently. `-z` emits raw bytes with NUL separators:
 *   `M \0 path \0`            plain change
 *   `R100 \0 oldPath \0 newPath \0`  rename/copy (three fields)
 */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0')
  const out: NameStatusEntry[] = []
  let i = 0

  while (i < tokens.length) {
    const status = tokens[i].trim()
    // Trailing NUL produces an empty final token; skip rather than break so a
    // stray blank in the middle can't truncate the whole listing.
    if (!status) {
      i += 1
      continue
    }

    const letter = status.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1]
      const filePath = tokens[i + 2]
      if (!oldPath || !filePath) break
      out.push({ status, filePath, oldPath })
      i += 3
    } else {
      const filePath = tokens[i + 1]
      if (!filePath) break
      out.push({ status, filePath })
      i += 2
    }
  }

  return out
}

/** Map a `--name-status` status letter to the UI's change type. */
export function changeTypeForStatus(status: string): 'created' | 'modified' | 'deleted' {
  switch (status.charAt(0)) {
    case 'A':
      return 'created'
    case 'D':
      return 'deleted'
    default:
      return 'modified'
  }
}

/** Mode/blob metadata for one path, from `git diff --raw`. */
export interface RawDiffEntry {
  srcMode: string
  dstMode: string
  srcSha: string
  dstSha: string
  /** Status token — 'M', 'A', 'D', 'R100'… */
  status: string
}

/** git prints an all-zero object id when a side has no blob (added/deleted/worktree). */
export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha)
}

/** Mode git reports for the absent side of an add or delete. */
const ABSENT_MODE = '000000'
/** Mode git reports for a submodule pointer. */
const GITLINK_MODE = '160000'

/** A submodule pointer — its "blob" ids are commit ids and cannot be read as blobs. */
export function isGitlinkEntry(entry: RawDiffEntry): boolean {
  return entry.srcMode === GITLINK_MODE || entry.dstMode === GITLINK_MODE
}

/**
 * Render one side of a submodule change the way git's own textual diff does.
 * `git cat-file blob <commitId>` fails with "bad file", which would otherwise
 * paint two fatal errors and an "unexplained" banner over every submodule bump.
 */
export function gitlinkSideContent(sha: string): string {
  return isZeroSha(sha) ? '' : `Subproject commit ${sha}\n`
}

/**
 * Parse `git diff --raw` output into the single entry describing our path.
 *   `:100644 100644 <srcSha> <dstSha> M<TAB>path`
 *   `:000000 100644 000…0 <dstSha> A<TAB>path`      added
 *   `:100644 100644 <srcSha> 000…0 M<TAB>path`      vs working tree
 *   `:100644 100644 <sha> <sha> R100<TAB>old<TAB>new`
 * When rename detection is disabled a rename arrives as a separate D and A pair;
 * those are combined so the pane still gets both sides.
 */
export function parseRawDiffEntry(raw: string): RawDiffEntry | null {
  const entries: RawDiffEntry[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(':')) continue
    // Paths follow the first TAB (or NUL under -z) — metadata is everything before it.
    const meta = trimmed
      .slice(1)
      .split(/[\t\0]/)[0]
      .trim()
      .split(/\s+/)
    if (meta.length < 5) continue
    entries.push({
      srcMode: meta[0],
      dstMode: meta[1],
      srcSha: meta[2],
      dstSha: meta[3],
      status: meta[4]
    })
  }

  if (entries.length === 0) return null
  if (entries.length === 1) return entries[0]

  const rename = entries.find((e) => /^[RC]/.test(e.status))
  if (rename) return rename

  const src = entries.find((e) => !isZeroSha(e.srcSha)) ?? entries[0]
  const dst = entries.find((e) => !isZeroSha(e.dstSha)) ?? entries[entries.length - 1]
  return {
    srcMode: src.srcMode,
    dstMode: dst.dstMode,
    srcSha: src.srcSha,
    dstSha: dst.dstSha,
    status: 'M'
  }
}

/**
 * Why both sides of a diff came back identical. "No differences" with no reason
 * is indistinguishable from a bug, so every identical pane has to name its cause.
 *
 * Only called once the two sides are known to be equal, so the observed content
 * — not the blob ids — is what justifies each answer. Blob ids are useless here:
 * the working-tree side is reported as all-zeros, so a chmod or rename against the
 * working tree can never be recognised by comparing SHAs.
 */
export function resolveIdenticalReason(
  entry: RawDiffEntry | null,
  bothSidesEmpty: boolean
): DiffIdenticalReason {
  // No entry: either a brand-new empty file (untracked, so git diff can't see it)
  // or a file the list still claims changed when git no longer agrees.
  if (!entry) return bothSidesEmpty ? 'empty-file' : 'no-diff-entry'
  // One side absent + equal content ⇒ the present side has no content either.
  if (entry.srcMode === ABSENT_MODE || entry.dstMode === ABSENT_MODE) return 'empty-file'
  if (entry.srcMode !== entry.dstMode) return 'mode-change'
  if (/^[RC]/.test(entry.status)) return 'rename-only'
  // Same mode, no rename, equal content, yet git listed it — never silent.
  return 'unexplained'
}

/**
 * Union untracked paths into a ref-diff listing as 'created'.
 * `git diff <base>` only sees files git already tracks, so a brand-new file is
 * invisible in the working-tree comparison modes even though their label
 * promises "all changes". Existing entries win — never duplicate a path.
 */
export function mergeUntrackedIntoRefDiff(
  entries: FileDetailEntry[],
  untracked: string[]
): FileDetailEntry[] {
  const seen = new Set(entries.map((e) => e.filePath))
  const merged = [...entries]
  for (const filePath of untracked) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    merged.push({ filePath, changeType: 'created', staged: false })
  }
  return merged
}

/**
 * Build `git diff --name-status` args for an already-resolved base ref.
 * Never emits the three-dot form — the base is resolved up-front so the file
 * *list* and the file *content* always share one comparison base.
 */
export function buildRefDiffArgs(base: string, toRef: string): string[] {
  return toRef === 'WORKING_TREE'
    ? ['diff', '--name-status', '-z', base] // base → working tree
    : ['diff', '--name-status', '-z', base, toRef] // base → toRef
}

interface PushStatusResult {
  branch: string
  commitsAhead: number
  hasRemote: boolean
}

export class RepoService {
  /**
   * Check whether dirPath is the *root* of its own git repo (not just nested
   * inside a parent repo). Uses `git rev-parse --show-toplevel` which returns
   * the repo root — if that doesn't match dirPath, we're inside a parent.
   */
  private async isGitRoot(dirPath: string): Promise<boolean> {
    try {
      const top = (await simpleGit(dirPath).revparse(['--show-toplevel'])).trim()
      return resolve(top) === resolve(dirPath)
    } catch {
      return false
    }
  }

  /**
   * Guarantee dirPath has its own `.git`. If it's already the root, no-op.
   * Otherwise `git init` inside dirPath — works even when nested in a parent repo.
   */
  async ensureOwnRepo(dirPath: string): Promise<void> {
    if (await this.isGitRoot(dirPath)) return
    await simpleGit(dirPath).init()
    logger.info(`Initialized dedicated git repo at ${dirPath}`)
  }

  /**
   * Initialize a git repository at the given path.
   */
  async initRepo(dirPath: string): Promise<{ repoPath: string }> {
    if (await this.isGitRoot(dirPath)) {
      logger.info(`Directory is already a git repo root: ${dirPath}`)
      return { repoPath: dirPath }
    }

    await simpleGit(dirPath).init()
    logger.info(`Initialized git repo at ${dirPath}`)
    return { repoPath: dirPath }
  }

  /**
   * Set or update the origin remote URL.
   */
  async setRemote(repoPath: string, remoteUrl: string): Promise<void> {
    const git = simpleGit(repoPath)
    const remotes = await git.getRemotes(true)
    const hasOrigin = remotes.some((r) => r.name === 'origin')

    if (hasOrigin) {
      await git.remote(['set-url', 'origin', remoteUrl])
      logger.info(`Updated origin remote to ${remoteUrl}`)
    } else {
      await git.addRemote('origin', remoteUrl)
      logger.info(`Added origin remote: ${remoteUrl}`)
    }
  }

  /**
   * Get repository info for a given path.
   */
  async getRepoInfo(repoPath: string): Promise<RepoInfo> {
    try {
      const git = simpleGit(repoPath)
      const isRepo = await git.checkIsRepo()
      if (!isRepo) {
        return { isRepo: false, hasRemote: false, currentBranch: '' }
      }

      let currentBranch = ''
      try {
        currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
      } catch {
        // Unborn branch (empty repo)
        currentBranch = 'main'
      }

      let remoteUrl: string | undefined
      let hasRemote = false
      try {
        const remotes = await git.getRemotes(true)
        const origin = remotes.find((r) => r.name === 'origin')
        if (origin?.refs?.fetch) {
          remoteUrl = origin.refs.fetch
          hasRemote = true
        }
      } catch {
        // No remote
      }

      return { isRepo: true, hasRemote, remoteUrl, currentBranch }
    } catch {
      return { isRepo: false, hasRemote: false, currentBranch: '' }
    }
  }

  /**
   * Check if the workspace has any uncommitted file changes via git status.
   */
  async hasUncommittedChanges(
    repoPath: string
  ): Promise<{ hasChanges: boolean; fileCount: number; files: string[] }> {
    try {
      await this.ensureOwnRepo(repoPath)
      const git = simpleGit(repoPath)
      const status = await git.status()
      const files = [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...status.renamed.map((r) => r.to)
      ]
      return { hasChanges: files.length > 0, fileCount: files.length, files }
    } catch (e) {
      logger.warn('Failed to check uncommitted changes:', e)
      return { hasChanges: false, fileCount: 0, files: [] }
    }
  }

  /**
   * Get detailed uncommitted file status for all files in the workspace.
   * Returns ALL uncommitted files from git status (no DB cross-reference).
   */
  async getUncommittedFileDetails(repoPath: string): Promise<FileDetailEntry[]> {
    try {
      await this.ensureOwnRepo(repoPath)
      const git = simpleGit(repoPath)
      const status = await git.status()

      const stagedSet = new Set([
        ...status.staged,
        ...status.renamed.filter((r) => status.staged.includes(r.to)).map((r) => r.to)
      ])

      const entries: FileDetailEntry[] = []

      for (const fp of status.modified) {
        entries.push({ filePath: fp, changeType: 'modified', staged: stagedSet.has(fp) })
      }
      for (const fp of [...status.created, ...status.not_added]) {
        entries.push({ filePath: fp, changeType: 'created', staged: stagedSet.has(fp) })
      }
      for (const fp of status.deleted) {
        entries.push({ filePath: fp, changeType: 'deleted', staged: stagedSet.has(fp) })
      }
      for (const r of status.renamed) {
        entries.push({ filePath: r.to, changeType: 'modified', staged: stagedSet.has(r.to) })
      }

      return entries
    } catch (e) {
      logger.warn('Failed to get uncommitted file details:', e)
      return []
    }
  }

  /**
   * Get old (HEAD) and new (working tree) content for side-by-side diff.
   * For new files: oldContent = ''. For deleted files: newContent = ''.
   */
  async getFileDiff(repoPath: string, filePath: string): Promise<FileDiffResult> {
    assertWithinRepo(repoPath, filePath)
    const git = simpleGit(repoPath)
    const language = detectLanguage(filePath)

    // Normalize: resolve handles both absolute and relative paths correctly.
    // join('/a/b', '/c/d') = '/a/b/c/d' (wrong for absolute paths)
    // resolve('/a/b', '/c/d') = '/c/d' (correct — uses last absolute path)
    const absoluteRepo = resolve(repoPath)
    const absoluteFile = resolve(repoPath, filePath)
    // Always produce a relative path for git show — absolute paths break git.show
    const normalizedPath = relative(absoluteRepo, absoluteFile)

    let oldContent = ''
    let newContent = ''
    let warning: string | undefined

    // Get old content from HEAD using normalized relative path
    try {
      oldContent = await git.show([`HEAD:${normalizedPath}`])
    } catch (e) {
      // A missing path is EXPECTED (file is new/untracked), and so is any failure
      // in a repo with no commits at all. Anything else is a real failure — surface
      // it instead of silently showing an empty side.
      oldContent = ''
      const msg = firstLine(e)
      // Resolved lazily — only a failed `git show` needs to know whether HEAD exists.
      const hasHead = await git.raw(['rev-parse', '--verify', 'HEAD']).then(
        () => true,
        () => false
      )
      if (shouldWarnOnShowFailure(hasHead, msg)) {
        warning = msg
        logger.warn(`git show HEAD:${normalizedPath} failed:`, msg)
      } else {
        logger.debug(`git show HEAD:${normalizedPath} — file is new or repo has no commits`)
      }
    }

    // Get new content from working tree
    try {
      newContent = await readFile(absoluteFile, 'utf-8')
    } catch {
      // File was deleted
      newContent = ''
    }

    // Detect binary files — return placeholder instead of garbled content
    if (isBinaryContent(oldContent) || isBinaryContent(newContent)) {
      return {
        oldContent: '(Binary file — cannot display diff)',
        newContent: '(Binary file — cannot display diff)',
        language: 'text',
        isBinary: true,
        warning
      }
    }

    return { oldContent, newContent, language, warning }
  }

  /**
   * Stage specific files and commit.
   */
  async commitFiles(
    repoPath: string,
    filePaths: string[],
    message: string
  ): Promise<{ commitHash: string }> {
    if (filePaths.length === 0) throw new Error('No files to commit')
    if (!message.trim()) throw new Error('Commit message is required')
    filePaths.forEach((fp) => assertWithinRepo(repoPath, fp))

    const git = simpleGit(repoPath)
    const fullMessage = appendAttribution(message)
    await git.add(filePaths)
    const result = await git.commit(fullMessage, filePaths)
    logger.info(`Committed ${filePaths.length} files: ${result.commit}`)
    return { commitHash: result.commit }
  }

  /** Get the current HEAD commit SHA. */
  async getHeadSha(repoPath: string): Promise<string> {
    const git = simpleGit(repoPath)
    return (await git.revparse(['HEAD'])).trim()
  }

  /**
   * Push current branch to origin.
   */
  async push(repoPath: string): Promise<{ branch: string; remote: string }> {
    const git = simpleGit({
      baseDir: repoPath,
      timeout: { block: 30_000 }
    }).env('GIT_TERMINAL_PROMPT', '0')
    const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    await git.push('origin', branch)
    logger.info(`Pushed branch ${branch} to origin`)
    return { branch, remote: 'origin' }
  }

  /**
   * Get push status — how many commits ahead of origin.
   */
  async getPushStatus(repoPath: string): Promise<PushStatusResult> {
    const git = simpleGit(repoPath)
    let branch = 'main'
    try {
      branch = await git.revparse(['--abbrev-ref', 'HEAD'])
    } catch {
      // Unborn branch
    }

    let hasRemote = false
    try {
      const remotes = await git.getRemotes(true)
      hasRemote = remotes.some((r) => r.name === 'origin')
    } catch {
      // No remotes
    }

    let commitsAhead = 0
    if (hasRemote) {
      try {
        const log = await git.log([`origin/${branch}..HEAD`])
        commitsAhead = log.total
      } catch {
        // Remote branch may not exist yet — all local commits are ahead
        try {
          const log = await git.log()
          commitsAhead = log.total
        } catch {
          // Empty repo
        }
      }
    }

    return { branch, commitsAhead, hasRemote }
  }

  async listBranches(repoPath: string): Promise<{
    local: string[]
    remote: string[]
    current: string
  }> {
    const git = simpleGit(repoPath)
    const branchSummary = await git.branch(['-a'])

    const local: string[] = []
    const remote: string[] = []

    for (const name of Object.keys(branchSummary.branches)) {
      if (name.startsWith('remotes/origin/')) {
        const shortName = name.replace('remotes/origin/', '')
        if (shortName !== 'HEAD') remote.push(shortName)
      } else {
        local.push(name)
      }
    }

    return {
      local,
      remote,
      current: branchSummary.current
    }
  }

  /**
   * Fetch latest refs from origin. Timeout after 15s to avoid blocking UI
   * on unreachable remotes.
   */
  async fetchOrigin(repoPath: string): Promise<{ fetched: boolean; error?: string }> {
    try {
      const git = simpleGit({
        baseDir: repoPath,
        timeout: { block: 15_000 }
      }).env('GIT_TERMINAL_PROMPT', '0')
      await git.fetch(['origin', '--prune'])
      return { fetched: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fetch failed'
      logger.warn('fetchOrigin failed:', msg)
      return { fetched: false, error: msg }
    }
  }

  /**
   * merge-base(fromRef, toRef) — the point where the branch diverged from the
   * target. Returns null when it can't be computed (shallow clone, worktree,
   * unrelated histories); callers fall back to fromRef and warn.
   */
  private async resolveMergeBase(
    git: ReturnType<typeof simpleGit>,
    fromRef: string,
    toRef: string
  ): Promise<string | null> {
    try {
      const target = toRef === 'WORKING_TREE' ? 'HEAD' : toRef
      return (await git.raw(['merge-base', fromRef, target])).trim() || null
    } catch {
      return null
    }
  }

  /**
   * Get files that differ between two refs using `git diff --name-status`.
   * When toRef is 'WORKING_TREE', diffs fromRef against the working directory.
   */
  async getRefDiffFiles(
    repoPath: string,
    fromRef: string,
    toRef: string
  ): Promise<FileDetailEntry[]> {
    const entries: FileDetailEntry[] = []
    let untracked: string[] = []

    try {
      await this.ensureOwnRepo(repoPath)
      const git = simpleGit(repoPath)
      // Resolve the branch point once and use it for BOTH the file list and the
      // per-file content (see getRefFileDiff) — mismatched bases render files as
      // "changed" whose two sides are identical, producing a blank diff pane.
      const base = (await this.resolveMergeBase(git, fromRef, toRef)) ?? fromRef

      // Working-tree comparisons claim to show every change; `git diff` alone
      // silently omits files git doesn't track yet.
      if (toRef === 'WORKING_TREE') untracked = (await git.status()).not_added

      const raw = await git.raw(buildRefDiffArgs(base, toRef))
      if (!raw.trim()) return mergeUntrackedIntoRefDiff(entries, untracked)

      for (const entry of parseNameStatusZ(raw)) {
        // Renames carry their source path through — looking the old side up at the
        // *new* path fails silently and renders the file as a 100% addition.
        entries.push({
          filePath: entry.filePath,
          changeType: changeTypeForStatus(entry.status),
          staged: false,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {})
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('unknown revision') || msg.includes('bad revision')) {
        throw new Error(`REF_NOT_FOUND: ${fromRef} or ${toRef} does not exist`)
      }
      logger.warn(`getRefDiffFiles(${fromRef} -> ${toRef}) failed:`, e)
    }

    return mergeUntrackedIntoRefDiff(entries, untracked)
  }

  /**
   * Ask git for the mode/blob metadata of one path, using the same command family
   * that produced the file list so the two can't disagree.
   */
  private async resolveRawDiffEntry(
    git: ReturnType<typeof simpleGit>,
    base: string,
    toRef: string,
    path: string,
    oldPath?: string
  ): Promise<RawDiffEntry | null> {
    const args = ['diff', '--raw', '--abbrev=40', base]
    if (toRef !== 'WORKING_TREE') args.push(toRef)
    args.push('--', path)
    // Both sides of a rename in the pathspec so git re-detects it and reports the
    // true source blob instead of an unrelated add.
    if (oldPath && oldPath !== path) args.push(oldPath)

    try {
      return parseRawDiffEntry(await git.raw(args))
    } catch (e) {
      logger.warn(`git diff --raw for ${path} failed:`, firstLine(e))
      return null
    }
  }

  /**
   * Read a blob by object id. Unlike `git show <ref>:<path>` this cannot fail for
   * path casing, quoting, rename or root-relative reasons — which is exactly how
   * both sides used to come back empty and render a bogus "no differences".
   */
  private async readBlob(
    git: ReturnType<typeof simpleGit>,
    sha: string,
    warnings: string[]
  ): Promise<string> {
    try {
      return await git.raw(['cat-file', 'blob', sha])
    } catch (e) {
      const msg = firstLine(e)
      warnings.push(msg)
      logger.warn(`git cat-file blob ${sha} failed:`, msg)
      return ''
    }
  }

  /** Legacy by-path lookup — only used when git reports no --raw entry at all. */
  private async showAtRef(
    git: ReturnType<typeof simpleGit>,
    ref: string,
    path: string,
    warnings: string[]
  ): Promise<string> {
    try {
      return await git.show([`${ref}:${path}`])
    } catch (e) {
      const msg = firstLine(e)
      // A missing path is EXPECTED (file added or deleted between the two refs)
      if (!isMissingPathError(msg)) {
        warnings.push(msg)
        logger.warn(`git show ${ref}:${path} failed:`, msg)
      }
      return ''
    }
  }

  /**
   * Get file content at two refs for side-by-side diff.
   * When toRef is 'WORKING_TREE', reads the file from disk for the new side.
   * `oldPath` is the rename source, when the file list detected one.
   */
  async getRefFileDiff(
    repoPath: string,
    filePath: string,
    fromRef: string,
    toRef: string,
    oldPath?: string
  ): Promise<FileDiffResult> {
    assertWithinRepo(repoPath, filePath)
    if (oldPath) assertWithinRepo(repoPath, oldPath)
    const git = simpleGit(repoPath)
    const language = detectLanguage(filePath)

    const absoluteRepo = resolve(repoPath)
    const absoluteFile = resolve(repoPath, filePath)
    const normalizedPath = relative(absoluteRepo, absoluteFile)
    const normalizedOldPath = oldPath
      ? relative(absoluteRepo, resolve(repoPath, oldPath))
      : undefined

    let oldContent = ''
    let newContent = ''
    const warnings: string[] = []

    // Resolve the same base getRefDiffFiles used for the file list — diffing
    // against fromRef's *tip* here while the list used the branch point makes
    // unrelated target-branch commits look like removals, and can make both
    // sides identical (blank pane).
    const mergeBase = await this.resolveMergeBase(git, fromRef, toRef)
    if (!mergeBase) {
      warnings.push(
        `Could not determine branch point — comparing against the tip of ${fromRef} instead.`
      )
    }
    const base = mergeBase ?? fromRef

    const entry = await this.resolveRawDiffEntry(
      git,
      base,
      toRef,
      normalizedPath,
      normalizedOldPath
    )

    if (entry && isGitlinkEntry(entry)) {
      // Submodule pointer — both "blobs" are commit ids that cat-file can't read.
      oldContent = gitlinkSideContent(entry.srcSha)
      newContent =
        toRef === 'WORKING_TREE'
          ? gitlinkSideContent(entry.dstSha) || 'Subproject commit (uncommitted change)\n'
          : gitlinkSideContent(entry.dstSha)
    } else {
      if (entry) {
        // Content by blob SHA — the list and the pane now share one source of truth.
        oldContent = isZeroSha(entry.srcSha) ? '' : await this.readBlob(git, entry.srcSha, warnings)
      } else {
        oldContent = await this.showAtRef(git, base, normalizedOldPath ?? normalizedPath, warnings)
      }

      if (toRef === 'WORKING_TREE') {
        // The working tree is the truth for this mode — never read it from an object.
        try {
          newContent = await readFile(absoluteFile, 'utf-8')
        } catch {
          // File was deleted in working tree
          newContent = ''
        }
      } else if (entry) {
        newContent = isZeroSha(entry.dstSha) ? '' : await this.readBlob(git, entry.dstSha, warnings)
      } else {
        newContent = await this.showAtRef(git, toRef, normalizedPath, warnings)
      }
    }

    const baseSha = mergeBase ? mergeBase.slice(0, 7) : undefined

    // Detect binary files — return placeholder instead of garbled content
    if (isBinaryContent(oldContent) || isBinaryContent(newContent)) {
      return {
        oldContent: '(Binary file — cannot display diff)',
        newContent: '(Binary file — cannot display diff)',
        language: 'text',
        isBinary: true,
        warning: warnings.length > 0 ? warnings.join(' — ') : undefined,
        baseSha
      }
    }

    // Identical sides always carry their cause — a bland "no differences" is
    // indistinguishable from a broken pane.
    let identicalReason: DiffIdenticalReason | undefined
    let modeChange: { from: string; to: string } | undefined
    if (oldContent === newContent) {
      identicalReason = resolveIdenticalReason(entry, oldContent === '')
      if (identicalReason === 'mode-change' && entry) {
        modeChange = { from: entry.srcMode, to: entry.dstMode }
      }
      if (identicalReason === 'unexplained') {
        warnings.push(
          'Git reports this file as changed but both sides resolved to identical content.'
        )
      }
    }

    return {
      oldContent,
      newContent,
      language,
      warning: warnings.length > 0 ? warnings.join(' — ') : undefined,
      baseSha,
      identicalReason,
      modeChange
    }
  }
}

export const repoService = new RepoService()

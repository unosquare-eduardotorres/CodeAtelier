import { readFile } from 'node:fs/promises'
import { extname, resolve, relative } from 'node:path'
import simpleGit from 'simple-git'
import type { RepoInfo, FileDiffResult } from '../../shared/types'
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

interface FileDetailEntry {
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  staged: boolean
}

/**
 * Build `git diff --name-status` args for an already-resolved base ref.
 * Never emits the three-dot form — the base is resolved up-front so the file
 * *list* and the file *content* always share one comparison base.
 */
export function buildRefDiffArgs(base: string, toRef: string): string[] {
  return toRef === 'WORKING_TREE'
    ? ['diff', '--name-status', base] // base → working tree
    : ['diff', '--name-status', base, toRef] // base → toRef
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
      // A missing path is EXPECTED (file is new/untracked). Anything else is a
      // real failure — surface it instead of silently showing an empty side.
      oldContent = ''
      const msg = firstLine(e)
      if (isMissingPathError(msg)) {
        logger.debug(`git show HEAD:${normalizedPath} — file is new`)
      } else {
        warning = msg
        logger.warn(`git show HEAD:${normalizedPath} failed:`, msg)
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

    try {
      await this.ensureOwnRepo(repoPath)
      const git = simpleGit(repoPath)
      // Resolve the branch point once and use it for BOTH the file list and the
      // per-file content (see getRefFileDiff) — mismatched bases render files as
      // "changed" whose two sides are identical, producing a blank diff pane.
      const base = (await this.resolveMergeBase(git, fromRef, toRef)) ?? fromRef

      const raw = await git.raw(buildRefDiffArgs(base, toRef))
      if (!raw.trim()) return entries

      for (const line of raw.trim().split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 2) continue

        const statusLetter = parts[0].charAt(0)
        // For renames (R100), use the destination path (parts[2])
        const filePath = statusLetter === 'R' ? (parts[2] ?? parts[1]) : parts[1]

        let changeType: 'created' | 'modified' | 'deleted'
        switch (statusLetter) {
          case 'A':
            changeType = 'created'
            break
          case 'D':
            changeType = 'deleted'
            break
          case 'R':
          case 'M':
          case 'C':
          default:
            changeType = 'modified'
            break
        }

        entries.push({ filePath, changeType, staged: false })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('unknown revision') || msg.includes('bad revision')) {
        throw new Error(`REF_NOT_FOUND: ${fromRef} or ${toRef} does not exist`)
      }
      logger.warn(`getRefDiffFiles(${fromRef} -> ${toRef}) failed:`, e)
    }

    return entries
  }

  /**
   * Get file content at two refs for side-by-side diff.
   * When toRef is 'WORKING_TREE', reads the file from disk for the new side.
   */
  async getRefFileDiff(
    repoPath: string,
    filePath: string,
    fromRef: string,
    toRef: string
  ): Promise<FileDiffResult> {
    assertWithinRepo(repoPath, filePath)
    const git = simpleGit(repoPath)
    const language = detectLanguage(filePath)

    const absoluteRepo = resolve(repoPath)
    const absoluteFile = resolve(repoPath, filePath)
    const normalizedPath = relative(absoluteRepo, absoluteFile)

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

    // Get old content from the comparison base
    try {
      oldContent = await git.show([`${base}:${normalizedPath}`])
    } catch (e) {
      oldContent = ''
      const msg = firstLine(e)
      // A missing path is EXPECTED (file is new in this branch)
      if (!isMissingPathError(msg)) {
        warnings.push(msg)
        logger.warn(`git show ${base}:${normalizedPath} failed:`, msg)
      }
    }

    // Get new content from toRef or working tree
    if (toRef === 'WORKING_TREE') {
      try {
        newContent = await readFile(absoluteFile, 'utf-8')
      } catch {
        // File was deleted in working tree
        newContent = ''
      }
    } else {
      try {
        newContent = await git.show([`${toRef}:${normalizedPath}`])
      } catch (e) {
        newContent = ''
        const msg = firstLine(e)
        // A missing path is EXPECTED (file deleted in toRef)
        if (!isMissingPathError(msg)) {
          warnings.push(msg)
          logger.warn(`git show ${toRef}:${normalizedPath} failed:`, msg)
        }
      }
    }

    const warning = warnings.length > 0 ? warnings.join(' — ') : undefined
    const baseSha = mergeBase ? mergeBase.slice(0, 7) : undefined

    // Detect binary files — return placeholder instead of garbled content
    if (isBinaryContent(oldContent) || isBinaryContent(newContent)) {
      return {
        oldContent: '(Binary file — cannot display diff)',
        newContent: '(Binary file — cannot display diff)',
        language: 'text',
        isBinary: true,
        warning,
        baseSha
      }
    }

    return { oldContent, newContent, language, warning, baseSha }
  }
}

export const repoService = new RepoService()

import { readFile } from 'node:fs/promises'
import { extname, resolve, relative } from 'node:path'
import simpleGit from 'simple-git'
import type { RepoInfo } from '../../shared/types'
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

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  // Handle Dockerfile without extension
  if (filePath.toLowerCase().endsWith('dockerfile')) return 'docker'
  return EXT_TO_LANGUAGE[ext] ?? 'text'
}

interface FileDetailEntry {
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  staged: boolean
}

interface FileDiffResult {
  oldContent: string
  newContent: string
  language: string
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

    // Get old content from HEAD using normalized relative path
    try {
      oldContent = await git.show([`HEAD:${normalizedPath}`])
    } catch (e) {
      // File is new (untracked) — no HEAD version. Log for debugging path issues.
      logger.debug(`git show HEAD:${normalizedPath} failed (file may be new):`, e)
      oldContent = ''
    }

    // Get new content from working tree
    try {
      newContent = await readFile(absoluteFile, 'utf-8')
    } catch {
      // File was deleted
      newContent = ''
    }

    return { oldContent, newContent, language }
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
    await git.add(filePaths)
    const result = await git.commit(message, filePaths)
    logger.info(`Committed ${filePaths.length} files: ${result.commit}`)
    return { commitHash: result.commit }
  }

  /**
   * Push current branch to origin.
   */
  async push(repoPath: string): Promise<{ branch: string; remote: string }> {
    const git = simpleGit(repoPath)
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
}

export const repoService = new RepoService()

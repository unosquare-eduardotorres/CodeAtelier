import simpleGit from 'simple-git'
import type { RepoInfo } from '../../shared/types'
import log from 'electron-log'

const logger = log.scope('Repo')

export class RepoService {
  /**
   * Initialize a git repository at the given path.
   */
  async initRepo(dirPath: string): Promise<{ repoPath: string }> {
    const git = simpleGit(dirPath)
    const isRepo = await git.checkIsRepo()
    if (isRepo) {
      logger.info(`Directory is already a git repo: ${dirPath}`)
      return { repoPath: dirPath }
    }

    await git.init()
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
   * Check if a conversation has uncommitted file changes in the workspace.
   * Cross-references tracked file changes in DB with actual git status.
   */
  async hasUncommittedChanges(
    repoPath: string,
    trackedFiles: string[]
  ): Promise<{ hasChanges: boolean; fileCount: number; files: string[] }> {
    if (trackedFiles.length === 0) {
      return { hasChanges: false, fileCount: 0, files: [] }
    }

    try {
      const git = simpleGit(repoPath)
      const status = await git.status()
      const changedPaths = new Set([
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...status.renamed.map((r) => r.to)
      ])

      const uncommittedFiles = trackedFiles.filter((fp) => changedPaths.has(fp))
      return {
        hasChanges: uncommittedFiles.length > 0,
        fileCount: uncommittedFiles.length,
        files: uncommittedFiles
      }
    } catch (e) {
      logger.warn('Failed to check uncommitted changes:', e)
      return { hasChanges: false, fileCount: 0, files: [] }
    }
  }
}

export const repoService = new RepoService()

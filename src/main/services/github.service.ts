import { Octokit } from '@octokit/rest'
import { safeStorage } from 'electron'
import simpleGit from 'simple-git'
import { workspaceRepository } from '../db/repositories'
import log from 'electron-log'

const logger = log.scope('GitHub')

export class GitHubService {
  /**
   * Validate a GitHub PAT: check it works and has the `repo` scope.
   */
  async validateToken(token: string): Promise<{ valid: boolean; login: string; scopes: string[] }> {
    try {
      const octokit = new Octokit({ auth: token })
      const response = await octokit.rest.users.getAuthenticated()
      const scopes = (response.headers['x-oauth-scopes'] ?? '').split(',').map((s) => s.trim())
      return { valid: true, login: response.data.login, scopes }
    } catch {
      return { valid: false, login: '', scopes: [] }
    }
  }

  /**
   * Validate, encrypt, and persist a GitHub PAT for a workspace.
   * Token is encrypted using Electron safeStorage (OS keychain) then stored as base64 in settingsJson.
   */
  async saveToken(workspaceId: string, token: string): Promise<{ login: string }> {
    const result = await this.validateToken(token)
    if (!result.valid) {
      throw new Error('Invalid GitHub token')
    }
    if (!result.scopes.includes('repo')) {
      throw new Error('Token missing required "repo" scope')
    }

    // Encrypt and store
    const encrypted = safeStorage.encryptString(token)
    const base64 = encrypted.toString('base64')

    const settings = workspaceRepository.getSettings(workspaceId)
    settings.githubTokenEncrypted = base64
    settings.githubLogin = result.login
    workspaceRepository.updateSettings(workspaceId, settings)

    logger.info(`GitHub token saved for workspace ${workspaceId} (user: ${result.login})`)
    return { login: result.login }
  }

  /**
   * Get the GitHub connection status for a workspace.
   */
  getStatus(workspaceId: string): { configured: boolean; login?: string } {
    const settings = workspaceRepository.getSettings(workspaceId)
    if (!settings.githubTokenEncrypted) {
      return { configured: false }
    }
    return { configured: true, login: settings.githubLogin as string | undefined }
  }

  /**
   * Remove stored GitHub token for a workspace.
   */
  removeToken(workspaceId: string): void {
    const settings = workspaceRepository.getSettings(workspaceId)
    delete settings.githubTokenEncrypted
    delete settings.githubLogin
    workspaceRepository.updateSettings(workspaceId, settings)
    logger.info(`GitHub token removed for workspace ${workspaceId}`)
  }

  /**
   * Check whether a workspace has a GitHub token configured.
   */
  isConfigured(workspaceId: string): boolean {
    const settings = workspaceRepository.getSettings(workspaceId)
    return !!settings.githubTokenEncrypted
  }

  /**
   * Create a pull request on GitHub.
   */
  async createPullRequest(params: {
    workspaceId: string
    repoPath: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<{ prUrl: string; prNumber: number }> {
    const octokit = this.getOctokit(params.workspaceId)
    const { owner, repo } = await this.parseRemoteUrl(params.repoPath)

    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      head: params.head,
      base: params.base,
      title: params.title,
      body: params.body
    })

    logger.info(`PR #${response.data.number} created: ${response.data.html_url}`)
    return { prUrl: response.data.html_url, prNumber: response.data.number }
  }

  /**
   * Get the status of a pull request (open, closed, merged).
   */
  async getPullRequestStatus(
    workspaceId: string,
    repoPath: string,
    prNumber: number
  ): Promise<string> {
    const octokit = this.getOctokit(workspaceId)
    const { owner, repo } = await this.parseRemoteUrl(repoPath)

    const response = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
    if (response.data.merged) return 'merged'
    return response.data.state // 'open' | 'closed'
  }

  /**
   * Delete a remote branch on GitHub.
   */
  async deleteRemoteBranch(workspaceId: string, repoPath: string, branch: string): Promise<void> {
    const octokit = this.getOctokit(workspaceId)
    const { owner, repo } = await this.parseRemoteUrl(repoPath)

    try {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` })
      logger.info(`Deleted remote branch ${branch} from ${owner}/${repo}`)
    } catch (e) {
      logger.warn(`Failed to delete remote branch ${branch}:`, e)
    }
  }

  /**
   * List review comments on a pull request.
   */
  async listPullRequestComments(
    workspaceId: string,
    repoPath: string,
    prNumber: number,
    perPage: number = 10
  ): Promise<
    Array<{
      id: number
      author: string
      body: string
      path: string
      line: number | null
      createdAt: string
    }>
  > {
    const octokit = this.getOctokit(workspaceId)
    const { owner, repo } = await this.parseRemoteUrl(repoPath)

    const response = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      sort: 'created',
      direction: 'desc'
    })

    return response.data.map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'unknown',
      body: c.body.slice(0, 500),
      path: c.path,
      line: c.line ?? null,
      createdAt: c.created_at
    }))
  }

  /**
   * List issues for the repository.
   */
  async listIssues(
    workspaceId: string,
    repoPath: string,
    opts: { state?: 'open' | 'closed' | 'all'; perPage?: number; labels?: string } = {}
  ): Promise<
    Array<{
      number: number
      title: string
      author: string
      state: string
      labels: string[]
      createdAt: string
      body: string | null
    }>
  > {
    const octokit = this.getOctokit(workspaceId)
    const { owner, repo } = await this.parseRemoteUrl(repoPath)

    const params: Record<string, unknown> = {
      owner,
      repo,
      state: opts.state ?? 'open',
      per_page: opts.perPage ?? 10,
      sort: 'created',
      direction: 'desc'
    }
    if (opts.labels) params.labels = opts.labels

    // @ts-expect-error — TODO: params built dynamically, Octokit expects strict shape
    const response = await octokit.rest.issues.listForRepo(params)

    // Filter out pull requests (GitHub API returns PRs as issues too)
    return response.data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        author: i.user?.login ?? 'unknown',
        state: i.state ?? 'unknown',
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        createdAt: i.created_at,
        body: i.body ? i.body.slice(0, 300) : null
      }))
  }

  /**
   * Get an authenticated Octokit instance for a workspace.
   */
  private getOctokit(workspaceId: string): Octokit {
    const settings = workspaceRepository.getSettings(workspaceId)
    const encrypted = settings.githubTokenEncrypted as string | undefined
    if (!encrypted) {
      throw new Error('GitHub token not configured for this workspace')
    }

    const buffer = Buffer.from(encrypted, 'base64')
    const token = safeStorage.decryptString(buffer)
    return new Octokit({ auth: token })
  }

  /**
   * Parse owner/repo from the git remote URL.
   */
  private async parseRemoteUrl(repoPath: string): Promise<{ owner: string; repo: string }> {
    const git = simpleGit(repoPath)
    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    if (!origin?.refs?.fetch) {
      throw new Error('No origin remote configured')
    }

    const url = origin.refs.fetch
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] }
    }

    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/)
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] }
    }

    throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`)
  }
}

export const githubService = new GitHubService()

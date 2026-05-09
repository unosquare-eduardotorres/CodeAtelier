import { Octokit } from '@octokit/rest'
import { safeStorage } from 'electron'
import simpleGit from 'simple-git'
import { workspaceRepository } from '../db/repositories'
import log from 'electron-log'
import type { GitHubTokenType } from '../../shared/types'

const logger = log.scope('GitHub')

// ── Token type detection ──────────────────────────────────────────

function detectTokenType(token: string): GitHubTokenType {
  if (token.startsWith('ghp_')) return 'classic'
  if (token.startsWith('github_pat_')) return 'fine-grained'
  return 'unknown'
}

export class GitHubService {
  /**
   * Validate a GitHub PAT: check it authenticates and detect its type.
   * Classic tokens return scopes via x-oauth-scopes header.
   * Fine-grained tokens return an empty header — scopes will be [].
   */
  async validateToken(
    token: string
  ): Promise<{ valid: boolean; login: string; scopes: string[]; tokenType: GitHubTokenType }> {
    const tokenType = detectTokenType(token)
    try {
      const octokit = new Octokit({ auth: token })
      const response = await octokit.rest.users.getAuthenticated()
      const rawScopes = response.headers['x-oauth-scopes'] ?? ''
      const scopes = rawScopes ? rawScopes.split(',').map((s) => s.trim()) : []
      return { valid: true, login: response.data.login, scopes, tokenType }
    } catch {
      return { valid: false, login: '', scopes: [], tokenType }
    }
  }

  /**
   * Validate, encrypt, and persist a GitHub PAT for a workspace.
   * Classic tokens are validated via x-oauth-scopes header (must include "repo").
   * Fine-grained tokens are validated by probing the workspace repo's API endpoints.
   * Token is encrypted using Electron safeStorage (OS keychain) then stored as base64 in settingsJson.
   */
  async saveToken(
    workspaceId: string,
    token: string
  ): Promise<{ login: string; tokenType: GitHubTokenType }> {
    const result = await this.validateToken(token)
    if (!result.valid) {
      throw new Error('Invalid GitHub token')
    }

    if (result.tokenType === 'classic') {
      if (!result.scopes.includes('repo')) {
        throw new Error(
          'Token missing required "repo" scope. Generate a classic token with the "repo" scope.'
        )
      }
    } else if (result.tokenType === 'fine-grained') {
      await this.probeFineGrainedPermissions(workspaceId, token)
    } else {
      // Unknown prefix — allow if authenticated, log a warning
      logger.warn('Unknown token prefix format — skipping scope validation')
    }

    // Encrypt and store
    const encrypted = safeStorage.encryptString(token)
    const base64 = encrypted.toString('base64')

    const settings = workspaceRepository.getSettings(workspaceId)
    settings.githubTokenEncrypted = base64
    settings.githubLogin = result.login
    settings.githubTokenType = result.tokenType
    workspaceRepository.updateSettings(workspaceId, settings)

    logger.info(
      `GitHub ${result.tokenType} token saved for workspace ${workspaceId} (user: ${result.login})`
    )
    return { login: result.login, tokenType: result.tokenType }
  }

  /**
   * Get the GitHub connection status for a workspace.
   */
  getStatus(workspaceId: string): {
    configured: boolean
    login?: string
    tokenType?: GitHubTokenType
  } {
    const settings = workspaceRepository.getSettings(workspaceId)
    if (!settings.githubTokenEncrypted) {
      return { configured: false }
    }
    return {
      configured: true,
      login: settings.githubLogin as string | undefined,
      tokenType: (settings.githubTokenType as GitHubTokenType | undefined) ?? 'classic'
    }
  }

  /**
   * Remove stored GitHub token for a workspace.
   */
  removeToken(workspaceId: string): void {
    const settings = workspaceRepository.getSettings(workspaceId)
    delete settings.githubTokenEncrypted
    delete settings.githubLogin
    delete settings.githubTokenType
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

    type ListForRepoParams = Parameters<typeof octokit.rest.issues.listForRepo>[0]
    const params: ListForRepoParams = {
      owner,
      repo,
      state: opts.state ?? 'open',
      per_page: opts.perPage ?? 10,
      sort: 'created',
      direction: 'desc'
    }
    if (opts.labels) params.labels = opts.labels

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
   * Probe the workspace repo to verify a fine-grained token has the required permissions.
   * Fine-grained PATs don't expose their permissions via headers, so we test
   * lightweight read-only API calls against the actual repo.
   * Skipped when the workspace has no remote configured yet.
   */
  private async probeFineGrainedPermissions(workspaceId: string, token: string): Promise<void> {
    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace?.repoPath) return

    let owner: string, repo: string
    try {
      const parsed = await this.parseRemoteUrl(workspace.repoPath)
      owner = parsed.owner
      repo = parsed.repo
    } catch {
      // No remote configured yet — can't probe, accept the token
      logger.info('No remote configured — skipping fine-grained permission probe')
      return
    }

    const octokit = new Octokit({ auth: token })

    // Probe: Can we read the repo? (Metadata + Contents)
    try {
      await octokit.rest.repos.get({ owner, repo })
    } catch (e: unknown) {
      const status = (e as { status?: number }).status
      if (status === 403 || status === 404) {
        throw new Error(
          `Token cannot access ${owner}/${repo}. Ensure the fine-grained token grants repository access for this repo.`
        )
      }
      throw e
    }

    // Probe: Can we list PRs? (Pull requests: Read)
    try {
      await octokit.rest.pulls.list({ owner, repo, per_page: 1 })
    } catch (e: unknown) {
      const status = (e as { status?: number }).status
      if (status === 403) {
        throw new Error(
          'Token missing "Pull requests: Read" permission. Update your fine-grained token permissions.'
        )
      }
    }

    // Probe: Can we list issues? (Issues: Read)
    try {
      await octokit.rest.issues.listForRepo({ owner, repo, per_page: 1 })
    } catch (e: unknown) {
      const status = (e as { status?: number }).status
      if (status === 403) {
        throw new Error(
          'Token missing "Issues: Read" permission. Update your fine-grained token permissions.'
        )
      }
    }

    // Note: Write permissions (PR create, branch delete) are not probed to avoid side effects.
    // Those will surface clear errors from the GitHub API at usage time.
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

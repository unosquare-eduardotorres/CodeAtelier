/**
 * autofix-pr.service — Orchestration for the `/autofix-pr` command.
 *
 * Gathers CI failures + review comments from a GitHub PR, then builds
 * a fix prompt to be sent to the current conversation's agent session.
 * The agent already has workspace tools and code context — no need to
 * spin up a separate agent.
 */
import log from 'electron-log/main'
import { githubService } from './github.service'
import { workspaceRepository } from '../db/repositories'
import { execSync } from 'node:child_process'

const autofixLog = log.scope('autofix-pr')

export interface AutofixContext {
  prNumber: number
  prTitle: string
  failedChecks: Array<{ name: string; summary: string | null }>
  reviewComments: Array<{
    author: string
    body: string
    path: string
    line: number | null
  }>
}

class AutofixPrService {
  /**
   * Gather PR context (CI failures + review comments) and build
   * a fix prompt to be sent to the current conversation's agent.
   */
  async buildFixPrompt(params: {
    workspaceId: string
    prNumber?: number
  }): Promise<{ prompt: string; context: AutofixContext }> {
    const workspace = workspaceRepository.findById(params.workspaceId)
    if (!workspace?.repoPath) throw new Error('No workspace repo path')

    if (!githubService.isConfigured(params.workspaceId)) {
      throw new Error(
        'GitHub is not configured for this workspace. Go to Settings → GitHub to add a token.'
      )
    }

    // 1. Resolve PR number
    let prNumber = params.prNumber
    if (!prNumber) {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspace.repoPath,
        encoding: 'utf-8',
        windowsHide: true
      }).trim()

      autofixLog.info(`[autofix-pr] Detecting PR for branch: ${branch}`)
      prNumber = await (githubService as any).findPrForBranch(
        params.workspaceId,
        workspace.repoPath,
        branch
      )
      if (!prNumber) {
        throw new Error(
          `No open PR found for branch "${branch}". Push your branch and create a PR first, or specify a PR number: \`/autofix-pr 42\``
        )
      }
    }

    autofixLog.info(`[autofix-pr] Processing PR #${prNumber}`)

    // 2. Fetch CI check status
    const checkStatus = await (githubService as any).getCheckStatus(
      params.workspaceId,
      workspace.repoPath,
      prNumber
    )

    const failedChecks = checkStatus.checkRuns.filter((c: any) => c.conclusion === 'failure')

    // 3. Fetch review comments
    const reviewComments = await githubService.listPullRequestComments(
      params.workspaceId,
      workspace.repoPath,
      prNumber,
      20
    )

    // 4. Build the prompt
    const sections: string[] = [`## Auto-Fix PR #${prNumber}`, '']

    if (failedChecks.length > 0) {
      sections.push('### ❌ Failed CI Checks')
      for (const check of failedChecks) {
        sections.push(`- **${check.name}**`)
        if (check.output.summary) {
          sections.push(`  \`\`\`\n  ${check.output.summary.slice(0, 1500)}\n  \`\`\``)
        }
      }
      sections.push('')
    }

    if (reviewComments.length > 0) {
      sections.push('### 💬 Review Comments')
      for (const comment of reviewComments) {
        const location = comment.path + (comment.line ? `:${comment.line}` : '')
        sections.push(`- **@${comment.author}** on \`${location}\`: ${comment.body}`)
      }
      sections.push('')
    }

    if (failedChecks.length === 0 && reviewComments.length === 0) {
      sections.push('✅ No CI failures or review comments found. The PR looks clean!')
    } else {
      sections.push('### Instructions')
      sections.push('Fix all the issues above:')
      sections.push(
        '1. Address each failed CI check by reading the error output and fixing the code'
      )
      sections.push('2. Address each review comment by making the requested change')
      sections.push('3. Run the project tests to verify your fixes')
      sections.push(
        '4. Do NOT create a new commit — just fix the files. I will handle the commit.'
      )
    }

    const context: AutofixContext = {
      prNumber,
      prTitle: `PR #${prNumber}`,
      failedChecks: failedChecks.map((c: any) => ({ name: c.name, summary: c.output.summary })),
      reviewComments
    }

    return { prompt: sections.join('\n'), context }
  }
}

export const autofixPrService = new AutofixPrService()

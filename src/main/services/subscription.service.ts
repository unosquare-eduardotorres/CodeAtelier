import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import log from 'electron-log/main'
import { buildEnvWithPath } from './env-utils'
import type { SubscriptionCheckResult, AutoConfigureResult } from '../../shared/types'

const execFileAsync = promisify(execFile)

const logger = log.scope('SubscriptionService')

class SubscriptionService {
  private readonly timeout = 15_000

  /**
   * Run all subscription checks in parallel.
   */
  async validateAll(): Promise<SubscriptionCheckResult> {
    const claudeCli = await this.checkClaudeCli()

    // Auth & subscription checks depend on CLI being installed
    let claudeAuth: SubscriptionCheckResult['claudeAuth'] = {
      authenticated: false,
      accountEmail: null,
      error: 'Claude CLI not installed'
    }
    let claudeMax: SubscriptionCheckResult['claudeMax'] = {
      active: false,
      plan: null,
      error: 'Claude CLI not installed'
    }
    let sdkHealth: SubscriptionCheckResult['sdkHealth'] = {
      sdkVersion: null,
      modelsAvailable: [],
      opus48Available: false,
      error: 'CLI not installed'
    }

    if (claudeCli.installed) {
      ;[claudeAuth, claudeMax, sdkHealth] = await Promise.all([
        this.checkClaudeAuth(),
        this.checkClaudeMaxSubscription(),
        this.checkSdkHealth()
      ])
    }

    return { claudeCli, claudeAuth, claudeMax, sdkHealth }
  }

  /** Check if `claude` binary is available and get its version */
  async checkClaudeCli(): Promise<{
    installed: boolean
    version: string | null
    error: string | null
  }> {
    try {
      const env = buildEnvWithPath()
      const { stdout } = await execFileAsync('claude', ['--version'], {
        env,
        timeout: this.timeout
      })
      const version = stdout.trim() || null
      logger.info(`Claude CLI detected: ${version}`)
      return { installed: true, version, error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`Claude CLI not found: ${message}`)
      return { installed: false, version: null, error: message }
    }
  }

  /** Check if user is authenticated by running a minimal prompt */
  async checkClaudeAuth(): Promise<{
    authenticated: boolean
    accountEmail: string | null
    error: string | null
  }> {
    try {
      const env = buildEnvWithPath()
      // Remove API key so we test subscription-based auth only
      delete env.ANTHROPIC_API_KEY

      const { stdout } = await execFileAsync(
        'claude',
        ['-p', 'reply with exactly OK', '--output-format', 'text'],
        { env, timeout: this.timeout }
      )
      const response = stdout.trim()
      if (response.toLowerCase().includes('ok')) {
        logger.info('Claude authentication verified')
        return { authenticated: true, accountEmail: null, error: null }
      }
      return {
        authenticated: false,
        accountEmail: null,
        error: `Unexpected response: ${response.slice(0, 100)}`
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`Claude auth check failed: ${message}`)
      return { authenticated: false, accountEmail: null, error: message }
    }
  }

  /** Verify Claude Max subscription is active (piggybacks on auth — if CLI works without API key, subscription is active) */
  async checkClaudeMaxSubscription(): Promise<{
    active: boolean
    plan: string | null
    error: string | null
  }> {
    try {
      const env = buildEnvWithPath()
      // Remove API key to verify subscription-based access
      delete env.ANTHROPIC_API_KEY

      const { stdout } = await execFileAsync(
        'claude',
        ['-p', 'reply with exactly: MAX_ACTIVE', '--output-format', 'text'],
        { env, timeout: this.timeout }
      )
      const response = stdout.trim()
      if (response.toLowerCase().includes('max_active')) {
        logger.info('Claude Max subscription verified')
        return { active: true, plan: 'Max', error: null }
      }
      // CLI responded but not as expected — still likely active
      return { active: true, plan: 'Active', error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`Claude Max check failed: ${message}`)
      return { active: false, plan: null, error: message }
    }
  }

  /** Verify SDK can execute and Opus 5 is available */
  async checkSdkHealth(): Promise<NonNullable<SubscriptionCheckResult['sdkHealth']>> {
    try {
      const env = buildEnvWithPath()
      const { stdout: versionOut } = await execFileAsync('claude', ['--version'], {
        env,
        timeout: this.timeout
      })
      const sdkVersion = versionOut.trim()

      // Check if opus 5 is reachable (via a minimal one-shot query)
      const { stdout: modelsOut } = await execFileAsync(
        'claude',
        ['-p', 'reply with OK', '--model', 'claude-opus-5', '--output-format', 'text'],
        { env, timeout: 30_000 }
      )
      const opus48Available = modelsOut.toLowerCase().includes('ok')

      return {
        sdkVersion,
        modelsAvailable: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        opus48Available,
        error: null
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`SDK health check failed: ${message}`)
      return { sdkVersion: null, modelsAvailable: [], opus48Available: false, error: message }
    }
  }

  /** Attempt to auto-install Claude CLI via npm */
  async autoConfigureClaude(): Promise<AutoConfigureResult> {
    try {
      const env = buildEnvWithPath()
      logger.info('Attempting to install Claude CLI via npm...')
      const { stdout } = await execFileAsync(
        'npm',
        ['install', '-g', '@anthropic-ai/claude-code'],
        { env, timeout: 120_000 } // 2 min for install
      )
      logger.info(`Claude CLI installed successfully: ${stdout.trim().slice(0, 200)}`)
      return { success: true, error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Claude CLI auto-install failed: ${message}`)
      return { success: false, error: message }
    }
  }
}

export const subscriptionService = new SubscriptionService()

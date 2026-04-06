import { join } from 'node:path'
import { existsSync } from 'node:fs'
import log from 'electron-log/main'
import { app } from 'electron'

const hookLogger = log.scope('HookRunner')

/**
 * Resolves paths to hook scripts for Claude CLI's --pre-tool-use-hook
 * and --post-tool-use-hook flags.
 *
 * In development, hooks live under src/main/hooks/.
 * In production, they're bundled alongside the main process entry point.
 */
class HookRunnerService {
  private cachedPreHookPath: string | null = null
  private cachedPostHookPath: string | null = null

  /**
   * Returns the absolute path to the pre-tool-use hook script, or null if not found.
   */
  getPreToolUseHookPath(): string | null {
    if (this.cachedPreHookPath !== null) return this.cachedPreHookPath

    const candidates = [
      // Development: relative to compiled main process
      join(__dirname, 'hooks', 'pre-tool-use-hook.sh'),
      // Development: source location
      join(app.getAppPath(), 'src', 'main', 'hooks', 'pre-tool-use-hook.sh'),
      // Production: bundled alongside main entry
      join(__dirname, '..', 'hooks', 'pre-tool-use-hook.sh'),
      join(app.getAppPath(), 'hooks', 'pre-tool-use-hook.sh'),
      // Production: extraResources copies to <app>/resources/hooks/
      join(process.resourcesPath ?? '', 'hooks', 'pre-tool-use-hook.sh')
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        hookLogger.info(`Pre-tool-use hook found: ${candidate}`)
        this.cachedPreHookPath = candidate
        return candidate
      }
    }

    hookLogger.warn('Pre-tool-use hook not found in any candidate path')
    this.cachedPreHookPath = null
    return null
  }

  /**
   * Returns the absolute path to the post-tool-use hook script, or null if not found.
   */
  getPostToolUseHookPath(): string | null {
    if (this.cachedPostHookPath !== null) return this.cachedPostHookPath

    const candidates = [
      join(__dirname, 'hooks', 'post-tool-use-hook.sh'),
      join(app.getAppPath(), 'src', 'main', 'hooks', 'post-tool-use-hook.sh'),
      join(__dirname, '..', 'hooks', 'post-tool-use-hook.sh'),
      join(app.getAppPath(), 'hooks', 'post-tool-use-hook.sh'),
      // Production: extraResources copies to <app>/resources/hooks/
      join(process.resourcesPath ?? '', 'hooks', 'post-tool-use-hook.sh')
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        hookLogger.info(`Post-tool-use hook found: ${candidate}`)
        this.cachedPostHookPath = candidate
        return candidate
      }
    }

    hookLogger.warn('Post-tool-use hook not found in any candidate path')
    this.cachedPostHookPath = null
    return null
  }

  /**
   * Clears cached paths — useful if hooks are added/removed at runtime.
   */
  clearCache(): void {
    this.cachedPreHookPath = null
    this.cachedPostHookPath = null
  }
}

export const hookRunnerService = new HookRunnerService()

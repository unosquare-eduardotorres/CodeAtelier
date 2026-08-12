/**
 * Tool error reporting — captures MCP tool errors to the bug tracker.
 * Extracted to avoid circular imports between chat-shared and chunk-router.
 */

import { app } from 'electron'
import { bugRepository } from '../db/repositories/bug.repository'
import { chatIpcLogger } from '../logger'

const log = chatIpcLogger

/**
 * Auto-capture MCP tool errors to the bug tracker.
 * Called when `isToolError` is true in any pipeline (Specialist, Grill, Audit).
 */
export function reportToolError(
  toolName: string,
  errorContent: string,
  context: { agentType: string; workspaceId?: string; agentId?: string }
): void {
  try {
    // Skip expected safety-guard rejections — these aren't real bugs
    if (toolName === 'Bash' && errorContent.includes('Blocked:')) {
      log.debug(`Suppressed expected Bash safety rejection: ${errorContent.slice(0, 100)}`)
      return
    }

    // Skip expected CLI permission/interaction errors — not application bugs
    if (
      errorContent.includes('has been denied') ||
      errorContent.includes('denied by timeout') ||
      errorContent.includes('want to proceed') ||
      errorContent.includes('requires approval') ||
      errorContent.includes('has been modified since read') ||
      errorContent.includes('is not enabled')
    ) {
      log.debug(`Suppressed CLI interaction error: ${errorContent.slice(0, 100)}`)
      return
    }

    const firstLine = errorContent.split('\n')[0]?.trim() ?? 'Unknown error'
    const SDK_BUILTIN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'])
    const prefix = SDK_BUILTIN_TOOLS.has(toolName) ? 'Tool error' : 'MCP tool error'
    bugRepository.upsertBug({
      process: 'main',
      severity: 'error',
      errorMessage: `${prefix}: ${toolName} — ${firstLine}`,
      stackTrace: errorContent.slice(0, 2048),
      componentName: context.agentType,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      appVersion: app.getVersion()
    })
  } catch (e) {
    log.warn('Failed to report tool error to bug tracker:', e)
  }
}

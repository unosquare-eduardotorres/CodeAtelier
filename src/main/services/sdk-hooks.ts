import log from 'electron-log/main'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

const hookLog = log.scope('SDKHooks')

const DANGEROUS_PATTERNS = [
  'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf $HOME',
  'git push --force main', 'git push --force master',
  'git push --force origin main', 'git push --force origin master',
  'git push -f origin main', 'git push -f origin master',
  'sudo ', 'mkfs.', 'dd if=', ':(){:|:&};:',
  'chmod -R 777 /', 'chmod -R 777 /*',
  'DROP DATABASE', 'DROP TABLE', 'TRUNCATE TABLE',
  '| bash', '| sh', 'npm publish'
]

export function isDangerousCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return DANGEROUS_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/**
 * Creates a PreToolUse scope guard hook for the SDK.
 * Blocks file writes outside the allowed cwd and dangerous bash commands.
 * Returns SDK-compatible HookCallback for use in query() hooks option.
 */
export function createScopeGuard(allowedCwd: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>

    // File scope check for Write/Edit
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput?.file_path as string
      if (filePath && !filePath.startsWith(allowedCwd)) {
        hookLog.warn(`Blocked file access outside scope: ${filePath}`)
        return { decision: 'block', reason: `File outside allowed scope: ${filePath}` }
      }
    }

    // Dangerous command check for Bash
    if (toolName === 'Bash') {
      const command = toolInput?.command as string
      if (command && isDangerousCommand(command)) {
        hookLog.warn(`Blocked dangerous command: ${command.substring(0, 100)}`)
        return { decision: 'block', reason: 'Dangerous command blocked by scope guard' }
      }
    }

    return {} // Allow — no decision means continue
  }
}

/**
 * Creates a PreToolUse hook that requests user approval for dangerous tools.
 * Auto-approves safe tools (Read, Grep, etc.) and caches decisions for 30s.
 */
export function createToolApprovalHook(agentId: string, taskId?: string): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    const toolInput = (input as Record<string, unknown>).tool_input as Record<string, unknown>

    const { toolApprovalService } = await import('./tool-approval.service')

    const approved = await toolApprovalService.requestApproval(
      toolName,
      toolInput,
      agentId,
      taskId
    )

    if (!approved) {
      hookLog.info(`Tool ${toolName} blocked by user for agent ${agentId}`)
      return { decision: 'block', reason: 'Blocked by user' }
    }

    return {} // Allow
  }
}

/**
 * Creates a standalone dangerous command guard (Bash-only).
 */
export function createDangerousCommandGuard(): HookCallback {
  return async (input) => {
    const toolName = (input as Record<string, unknown>).tool_name as string
    if (toolName !== 'Bash') return {}
    const command = ((input as Record<string, unknown>).tool_input as Record<string, unknown>)?.command as string
    if (command && isDangerousCommand(command)) {
      return { decision: 'block', reason: 'Dangerous command blocked' }
    }
    return {}
  }
}

import log from 'electron-log/main'

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

export function createScopeGuard(allowedCwd: string) {
  return async (input: Record<string, unknown>) => {
    const toolName = input.tool_name as string
    const toolInput = input.tool_input as Record<string, unknown>

    // File scope check for Write/Edit
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput?.file_path as string
      if (filePath && !filePath.startsWith(allowedCwd)) {
        hookLog.warn(`Blocked file access outside scope: ${filePath}`)
        return { decision: 'block', reason: `File outside scope: ${filePath}` }
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

    return {} // Allow
  }
}

export function createDangerousCommandGuard() {
  return async (input: Record<string, unknown>) => {
    const toolName = input.tool_name as string
    if (toolName !== 'Bash') return {}
    const command = (input.tool_input as Record<string, unknown>)?.command as string
    if (command && isDangerousCommand(command)) {
      return { decision: 'block', reason: 'Dangerous command blocked' }
    }
    return {}
  }
}

/**
 * Tool auto-approval logic for the permission_prompt MCP tool.
 * Extracted from control-actions-server.ts for testability.
 *
 * Decides which tool permission requests can be auto-approved server-side
 * (without showing a UI modal) based on tool name, input, and conversation mode.
 */

/** Tools that are inherently safe (read-only, no side effects) — always auto-approved. */
export const AUTO_APPROVE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'SummarizePage',
  'Snapshot',
  'Evaluate' // browser read tools
])

/** Read-only Bash command prefixes that are safe to auto-approve in any mode. */
export const SAFE_BASH_PREFIXES = [
  // Git read-only
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git tag',
  'git remote',
  'git rev-parse',
  'git describe',
  'git stash list',
  'git grep',
  'git fetch',
  'git config',
  // File inspection
  'ls',
  'cat ',
  'head ',
  'tail ',
  'wc ',
  'find ',
  'du ',
  'df ',
  'stat ',
  'file ',
  'tree ',
  'readlink ',
  // Shell builtins (read-only)
  'echo ',
  'pwd',
  'whoami',
  'date',
  'uname',
  'which ',
  'type ',
  'env',
  'printenv',
  'cd ', // directory change — no side effects
  // Node.js / npm
  'npm ls',
  'npm list',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'npm --version',
  'npm run build',
  'npx tsc --noEmit',
  'npx tsc -noEmit',
  'npx tsx ',
  'npx vitest',
  'npx jest',
  'npx playwright',
  'node --version',
  'node -v',
  'node -e ',
  // .NET
  'dotnet test',
  'dotnet build',
  'dotnet run',
  'dotnet --version',
  // Python
  'python -m pytest',
  'python -c ',
  'python3 -m pytest',
  'python3 -c ',
  // Other
  'grep ',
  'sort ',
  'uniq ',
  'awk ',
  'sed -n ',
  'jq ',
  'cargo test',
  'cargo build',
  'cargo check',
  'go test',
  'go build',
  'make test',
  'make build',
  'make lint',
  'make check'
]

/**
 * Dangerous patterns — commands containing these substrings should NEVER be
 * auto-approved, even in build mode.
 */
const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf $HOME',
  'git push --force',
  'git push -f ',
  'sudo ',
  'mkfs.',
  'dd if=',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'DROP DATABASE',
  'DROP TABLE',
  'TRUNCATE TABLE',
  '| bash',
  '| sh',
  'curl.*| bash',
  'wget.*| sh',
  'eval "$(curl',
  'eval "$(wget',
  '> /dev/sda',
  'npm publish',
  'npx publish'
]

/**
 * Tools that execute a shell command via a `command` input.
 *
 * The dangerous-command veto used to be gated on the literal `toolName ===
 * 'Bash'`, so every sibling shell tool the CLI ships (`local_bash`,
 * `PowerShell`) skipped DANGEROUS_PATTERNS entirely — `rm -rf /` through
 * `local_bash` was auto-approved in build mode. Membership here is what makes
 * a tool subject to command inspection, so new shell siblings must be added.
 */
export const SHELL_TOOLS = new Set(['Bash', 'local_bash', 'PowerShell'])

function isDangerousCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return DANGEROUS_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/**
 * Strip a leading `cd "..." &&` or `cd ... &&` prefix from a compound command,
 * returning the actual operation. Handles both quoted and unquoted paths,
 * and Windows paths with backslashes.
 *
 * Examples:
 *   'cd "C:/Users/foo/project" && git status' → 'git status'
 *   'cd /tmp && npm test'                     → 'npm test'
 *   'git status'                              → 'git status' (unchanged)
 */
export function stripCdPrefix(command: string): string {
  // Match: cd <optional-quoted-path> && <rest>
  // Handles: cd "path" && rest, cd 'path' && rest, cd path && rest
  const match = command.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)/)
  return match ? match[1].trim() : command
}

/**
 * Decide whether a tool permission request should be auto-approved server-side.
 *
 * @param toolName  - The tool requesting permission (e.g. 'Bash', 'mcp__mulldev__build')
 * @param input     - The tool's input parameters
 * @param mode      - The conversation mode ('plan' | 'build' | 'danger')
 */
export function shouldAutoApprove(
  toolName: string,
  input: Record<string, unknown>,
  mode: string = 'plan'
): boolean {
  // 1. Read-only SDK tools — always auto-approved
  if (AUTO_APPROVE_TOOLS.has(toolName)) return true

  // 2. User-configured MCP tools — auto-approved in any mode
  //    These are explicitly set up by the user in their workspace MCP config.
  if (toolName.startsWith('mcp__')) return true

  // 3. Write/Edit in build or danger mode — already covered by CLI's acceptEdits,
  //    but belt-and-suspenders in case the request reaches us.
  if ((mode === 'build' || mode === 'danger') && (toolName === 'Write' || toolName === 'Edit')) {
    return true
  }

  // 4. Shell commands (Bash and its siblings — see SHELL_TOOLS)
  if (SHELL_TOOLS.has(toolName) && typeof input.command === 'string') {
    const rawCmd = input.command.trim()

    // Never auto-approve dangerous commands
    if (isDangerousCommand(rawCmd)) return false

    // Strip cd prefix from compound commands before checking safe prefixes
    const cmd = stripCdPrefix(rawCmd)

    // Check safe prefixes (works in any mode)
    if (SAFE_BASH_PREFIXES.some((prefix) => cmd.startsWith(prefix))) return true

    // In build/danger mode: auto-approve non-dangerous Bash
    // The user has consented to modifications by entering build mode.
    if (mode === 'build' || mode === 'danger') return true
  }

  return false
}

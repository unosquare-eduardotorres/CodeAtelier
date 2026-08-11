/**
 * Refusal logic for shell commands whose entire body is an idle wait.
 *
 * On Windows every one of these spawns a console window we cannot hide: the
 * `windowsHide` flag applies to the `CreateProcess` call we make, not to a
 * process the Claude CLI creates two levels down. The only place we can stop it
 * is the permission gate, before the CLI runs anything.
 *
 * Extracted from control-actions-server.ts so the classification is unit-testable
 * without executing the server's `main()` bootstrap on import.
 */
import { SHELL_TOOLS, stripCdPrefix } from './tool-auto-approve'

/** Returned to the model on a refusal — it names the replacement tools. */
export const IDLE_WAIT_MESSAGE =
  'Idle waiting in a shell is disabled. On Windows it opens a console window and ' +
  'blocks the turn without telling you anything. Use ' +
  '`mcp__process-manager__wait_process` (waits inside the app, no subprocess) or ' +
  '`mcp__process-manager__run_background` with `notifyOnExit: true`.'

/**
 * Commands that do nothing but idle. Each must match the WHOLE command — a
 * chained command is rejected by the caller before these are consulted.
 */
const IDLE_WAIT_PATTERNS: RegExp[] = [
  // sleep 30 · sleep 0.5 · sleep 10s · sleep infinity
  /^sleep\s+(?:\d+(?:\.\d+)?[smhd]?|infinity)\s*$/i,
  // Start-Sleep -Seconds 30 · Start-Sleep 5
  /^start-sleep\b/i,
  // timeout /t 30 /nobreak — the `/t` form only. Bare `timeout 30 npm test` is a
  // real command runner on POSIX and must keep working.
  /^timeout\s+\/t\s+\d+/i
]

/** The Windows "sleep" idiom: pinging loopback N times purely to burn N seconds. */
function isPingSleepIdiom(command: string): boolean {
  if (!/^ping\b/i.test(command)) return false
  return /\s-n\s+\d+/i.test(command) && /\b(?:127\.0\.0\.1|localhost|::1)\b/i.test(command)
}

/**
 * Classify a permission request as an idle wait.
 *
 * @returns guidance to return to the model, or `null` when the command is not a
 *          pure idle wait and must proceed to normal approval.
 */
export function classifyIdleWait(toolName: string, input: Record<string, unknown>): string | null {
  if (!SHELL_TOOLS.has(toolName)) return null
  if (typeof input.command !== 'string') return null

  const command = stripCdPrefix(input.command.trim()).trim()
  if (!command) return null

  // Any chaining or backgrounding means the wait is part of real work —
  // `sleep 2 && curl localhost:3000` is a poll, not an idle wait.
  if (/[;|&]/.test(command)) return null

  if (IDLE_WAIT_PATTERNS.some((p) => p.test(command))) return IDLE_WAIT_MESSAGE
  if (isPingSleepIdiom(command)) return IDLE_WAIT_MESSAGE

  return null
}

/**
 * Builder for the JSON body a `--permission-prompt-tool` must return to the
 * Claude CLI.
 *
 * `updatedInput` is REQUIRED on an allow — a result of `{"behavior":"allow"}`
 * with the key missing is rejected by the CLI, the tool call fails, and the turn
 * ends with no assistant output. It is therefore always populated, falling back
 * to `{}`, and never left undefined.
 *
 * Extracted from control-actions-server.ts purely so the logic is unit-testable
 * without executing the server's `main()` bootstrap on import.
 */

export const PERMISSION_DENIED_MESSAGE = 'User denied the permission request.'

/**
 * Build the permission result body.
 *
 * @param approved  Whether the user approved the tool call.
 * @param input     The tool input to echo back on an allow. Missing/undefined
 *                  falls back to `{}` so the key is always present.
 * @param denyMessage Message returned on a deny.
 */
export function buildPermissionResult(
  approved: boolean,
  input: Record<string, unknown> | undefined,
  denyMessage: string = PERMISSION_DENIED_MESSAGE
): string {
  return approved
    ? JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} })
    : JSON.stringify({ behavior: 'deny', message: denyMessage })
}

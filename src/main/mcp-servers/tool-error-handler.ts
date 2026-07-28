/**
 * Shared error boundary for MCP tool handlers.
 *
 * Wraps a tool handler so that uncaught errors return { isError: true }
 * to the MCP client. Without this, errors either crash the server or
 * return error text as successful content — both result in the UI
 * showing a green checkmark for a failed tool.
 */

/** MCP tool result shape (inline — the SDK doesn't export a named type). */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Wraps an MCP tool handler to catch errors and return them with isError: true.
 * This ensures the MCP client (Claude CLI) sees the failure as an error, not a success.
 */
export function withErrorBoundary<T>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    try {
      return await handler(args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[${toolName}] Tool execution failed:`, message)
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `[${toolName}] Error: ${message}`
          }
        ]
      }
    }
  }
}

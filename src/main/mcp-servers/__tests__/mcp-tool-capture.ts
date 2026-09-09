/**
 * Test seam for MCP servers.
 *
 * The servers register their tools on a module-scoped McpServer instance via
 * `server.tool(name, description, zodShape, handler)`. The SDK in this repo
 * (1.29.x) ships no in-memory transport, and the server instance itself is not
 * exported — so tests patch `McpServer.prototype.tool` BEFORE importing a
 * server module (or calling its exported register function), capture every
 * registration, and then invoke the real handlers directly with plain args.
 *
 * This exercises the actual handler bodies — the formatting, filtering, error
 * mapping and repository plumbing — without a stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface CapturedTool {
  name: string
  description: string
  /** The handler as registered (may be wrapped by withErrorBoundary). */
  handler: (args: any, extra?: any) => Promise<any>
  /** The zod raw shape / params object as registered, when present. */
  params: unknown
}

export interface ToolCapture {
  /** name → registration */
  tools: Map<string, CapturedTool>
  /** Registration order. */
  names: string[]
  restore(): void
}

/**
 * Patch McpServer.prototype.tool to capture registrations while still letting
 * the real SDK validate and store them. Restore with `restore()` — always
 * restore before the file finishes, or a later import registers into the
 * capture instead of a live server.
 *
 * Signatures used by this repo's servers:
 *   tool(name, cb) | tool(name, description, cb) | tool(name, description, zodShape, cb)
 * The handler is the last function argument; a params object is the argument
 * between description and handler.
 */
export function patchToolCapture(): ToolCapture {
  const original = McpServer.prototype.tool as (...args: unknown[]) => unknown
  const tools = new Map<string, CapturedTool>()
  const names: string[] = []

  McpServer.prototype.tool = function patchedTool(this: McpServer, ...args: unknown[]) {
    const name = args[0] as string
    const handler = [...args]
      .reverse()
      .find((a) => typeof a === 'function') as CapturedTool['handler'] | undefined
    const description = typeof args[1] === 'string' ? (args[1] as string) : ''
    const params =
      args.length >= 4 ? args[2] : args.length === 3 && typeof args[1] !== 'string' ? args[1] : undefined
    if (handler) {
      tools.set(name, { name, description, handler, params })
      names.push(name)
    }
    return original.apply(this, args)
  } as never

  return {
    tools,
    names,
    restore: () => {
      McpServer.prototype.tool = original as never
    }
  }
}

/**
 * Invoke a captured handler the way the SDK would: when the tool registered a
 * zod raw shape, parse the args through it first — that is where `.default()`
 * values (e.g. recall_conversation's before/after) and coercion are applied.
 * Calling `handler(args)` directly skips validation, and a defaulted field
 * arrives as undefined (e.g. `undefined + undefined + 1 > 25` → NaN slicing).
 */
export async function invokeTool(
  capture: ToolCapture,
  name: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const tool = capture.tools.get(name)
  if (!tool) throw new Error(`no captured tool named "${name}" (have: ${capture.names.join(', ')})`)
  const shape = tool.params && typeof tool.params === 'object' ? (tool.params as any) : null
  const looksLikeZodShape =
    shape && Object.values(shape).some((v: any) => v && typeof v === 'object' && 'safeParse' in v)
  const parsed = looksLikeZodShape ? z.object(shape).parse(args) : args
  return tool.handler(parsed)
}

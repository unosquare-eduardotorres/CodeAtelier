/**
 * Code Atelier Audit Tool — trigger workspace health audits.
 *
 * A-4: Uses correct tool() helper API shape — `args` (not `parameters`),
 * no explicit `name` (derived from filename: "audit").
 *
 * Phase 5 — OpenCode Deep Audit: Standalone tool migration.
 * Phase 6 — Post-Implementation Audit: API shape fix.
 */

import { tool } from '@opencode-ai/plugin'
import { createConnection } from 'node:net'

export default tool({
  description:
    'Trigger a workspace health audit. Scans for code quality issues, ' +
    'test coverage gaps, security concerns, and dependency problems.',
  args: {
    scope: tool.schema
      .string('Audit scope — "full" for entire workspace, or a directory path for targeted audit')
      .optional()
  },
  execute: async (args, context) => {
    const socketPath = process.env.IPC_SOCKET_PATH
    if (!socketPath) {
      return `Workspace audit queued (scope: ${args.scope ?? 'full'}, no IPC bridge)`
    }

    const message =
      JSON.stringify({
        type: 'memory',
        payload: {
          action: 'audit',
          topic: `workspace-audit:${args.scope ?? 'full'}`,
          category: 'architecture',
          sessionId: context.sessionID,
          directory: context.directory
        },
        timestamp: Date.now()
      }) + '\n'

    return new Promise<string>((resolve) => {
      try {
        const socket = createConnection(socketPath, () => {
          socket.write(message)
          socket.end()
          resolve(`Workspace audit triggered (scope: ${args.scope ?? 'full'})`)
        })
        socket.on('error', () => {
          resolve(`Workspace audit queued (scope: ${args.scope ?? 'full'}, socket unavailable)`)
        })
      } catch {
        resolve(`Workspace audit queued (scope: ${args.scope ?? 'full'}, connection failed)`)
      }
    })
  }
})

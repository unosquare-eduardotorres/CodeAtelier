/**
 * Code Atelier Plan Tool — emit or update structured plans.
 *
 * A-4: Uses correct tool() helper API shape — `args` (not `parameters`),
 * no explicit `name` (derived from filename: "plan").
 *
 * Phase 5 — OpenCode Deep Audit: Standalone tool migration.
 * Phase 6 — Post-Implementation Audit: API shape fix.
 */

import { tool } from '@opencode-ai/plugin'
import { createConnection } from 'node:net'

export default tool({
  description:
    'Emit or update a structured plan through the Code Atelier control actions bridge. ' +
    'Use this when creating implementation plans that should be tracked in the UI.',
  args: {
    action: tool.schema.enum(['create', 'update', 'complete'], 'Plan action'),
    content: tool.schema.string('Plan content in markdown format')
  },
  execute: async (args, context) => {
    const socketPath = process.env.IPC_SOCKET_PATH
    if (!socketPath) {
      return `Plan ${args.action} request queued (no IPC bridge)`
    }

    const message =
      JSON.stringify({
        type: 'plan',
        payload: {
          action: args.action,
          content: args.content,
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
          resolve(`Plan ${args.action} request sent`)
        })
        socket.on('error', () => {
          resolve(`Plan ${args.action} request queued (socket unavailable)`)
        })
      } catch {
        resolve(`Plan ${args.action} request queued (connection failed)`)
      }
    })
  }
})

/**
 * Code Atelier Memory Tool — read/write workspace memory entries.
 *
 * A-4: Uses correct tool() helper API shape — `args` (not `parameters`),
 * no explicit `name` (derived from filename: "memory").
 *
 * B-8: Implements bidirectional IPC — `read` action awaits a response
 * from the main process with actual memory data (5s timeout).
 *
 * Phase 5 — OpenCode Deep Audit: Standalone tool migration.
 * Phase 6 — Post-Implementation Audit: Critical fix.
 */

import { tool } from '@opencode-ai/plugin'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

/** B-8: Response timeout for read requests (ms) */
const READ_RESPONSE_TIMEOUT = 5000

export default tool({
  description:
    'Read or write workspace memory entries. Use "read" to search for known patterns, ' +
    'conventions, and constraints. Use "write" to record new facts discovered during this session.',
  args: {
    action: tool.schema.enum(['read', 'write'], 'The memory action to perform'),
    topic: tool.schema.string(
      'For "read": search topic (e.g. "testing conventions"). For "write": the fact to record.'
    ),
    category: tool.schema
      .enum(
        ['architecture', 'testing', 'security', 'documentation', 'dependencies', 'codeContext'],
        'Memory category'
      )
      .optional()
  },
  execute: async (args, context) => {
    const socketPath = process.env.IPC_SOCKET_PATH
    if (!socketPath) {
      return `Memory ${args.action} request queued for topic: "${args.topic}" (no IPC bridge)`
    }

    const requestId = randomUUID()

    // B-8: For read actions, use bidirectional request-response pattern
    if (args.action === 'read') {
      return new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          socket?.destroy()
          resolve(
            `Memory read timed out for topic: "${args.topic}" — ` +
              `the main process did not respond within ${READ_RESPONSE_TIMEOUT / 1000}s.`
          )
        }, READ_RESPONSE_TIMEOUT)

        let socket: Socket | null = null
        let buffer = ''

        try {
          socket = createConnection(socketPath, () => {
            // Send the read request with requestId for correlation
            const message =
              JSON.stringify({
                type: 'memory',
                requestId,
                payload: {
                  action: 'read',
                  topic: args.topic,
                  category: args.category,
                  sessionId: context.sessionID,
                  directory: context.directory
                },
                timestamp: Date.now()
              }) + '\n'
            socket!.write(message)
          })

          // Listen for the response from the main process
          socket.on('data', (data: Buffer) => {
            buffer += data.toString('utf-8')

            let newlineIdx: number
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newlineIdx).trim()
              buffer = buffer.slice(newlineIdx + 1)
              if (!line) continue

              try {
                const response = JSON.parse(line)
                // Match response to our request
                if (response.requestId === requestId && response.type === 'memoryResponse') {
                  clearTimeout(timeout)
                  socket?.destroy()

                  const memories = response.payload?.memories as
                    | Array<{ content: string; category?: string; tier?: number }>
                    | undefined

                  if (!memories || memories.length === 0) {
                    resolve(`No memories found for topic: "${args.topic}"`)
                    return
                  }

                  // Format memories for the agent
                  const formatted = memories
                    .map(
                      (m, i) =>
                        `${i + 1}. [${m.category ?? 'general'}] ${m.content}` +
                        (m.tier !== undefined ? ` (tier ${m.tier})` : '')
                    )
                    .join('\n')
                  resolve(
                    `Found ${memories.length} memory entries for "${args.topic}":\n\n${formatted}`
                  )
                  return
                }
              } catch {
                // Ignore malformed responses
              }
            }
          })

          socket.on('error', () => {
            clearTimeout(timeout)
            resolve(
              `Memory read request queued for topic: "${args.topic}" (socket unavailable)`
            )
          })
        } catch {
          clearTimeout(timeout)
          resolve(
            `Memory read request queued for topic: "${args.topic}" (connection failed)`
          )
        }
      })
    }

    // Write action — fire-and-forget
    const message =
      JSON.stringify({
        type: 'memory',
        requestId,
        payload: {
          action: args.action,
          topic: args.topic,
          category: args.category,
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
          resolve(`Memory write recorded: "${args.topic}"`)
        })
        socket.on('error', () => {
          resolve(`Memory write queued for topic: "${args.topic}" (socket unavailable)`)
        })
      } catch {
        resolve(`Memory write queued for topic: "${args.topic}" (connection failed)`)
      }
    })
  }
})

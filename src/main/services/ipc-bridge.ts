/**
 * IPC Bridge — Unix domain socket server for MCP server ↔ Electron communication.
 *
 * When using the CLI executor, MCP servers run as external stdio processes (spawned
 * by Claude CLI). They can't directly call Electron IPC. This bridge provides a
 * Unix domain socket that externalized MCP servers connect to for event delivery.
 *
 * Events:
 *   plan     → control-actions server emitted a structured plan
 *   askUser  → control-actions server emitted clarifying questions
 *   memory   → control-actions server emitted a memory
 *
 * The main process creates the socket server before spawning the CLI. The socket
 * path is passed to MCP servers via IPC_SOCKET_PATH environment variable.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import log from 'electron-log/main'

const bridgeLog = log.scope('IPCBridge')

/**
 * Event types emitted by externalized MCP servers.
 */
export interface IpcBridgeEvent {
  type:
    | 'plan'
    | 'askUser'
    | 'memory'
    | 'askUserResponse'
    | 'permission'
    | 'permissionResponse'
    | 'fileEdited'
    | 'memoryResponse'
    | 'phaseProgress'
  payload: unknown
  /** For request-response patterns: correlates response to request. */
  requestId?: string
  timestamp: number
}

/**
 * IPC Bridge server — listens on a Unix domain socket for events from
 * externalized MCP servers.
 *
 * Usage:
 *   const bridge = new IpcBridge()
 *   const socketPath = await bridge.start()
 *   // Pass socketPath to MCP server as IPC_SOCKET_PATH env var
 *   bridge.on('plan', (payload) => { ... })
 *   bridge.on('askUser', (payload) => { ... })
 *   bridge.on('memory', (payload) => { ... })
 */
export class IpcBridge extends EventEmitter {
  private server: NetServer | null = null
  private socketPath: string | null = null
  private clients: Set<Socket> = new Set()
  private _isListening = false

  /**
   * Start the Unix domain socket server.
   * Returns the socket path for passing to MCP servers.
   */
  async start(): Promise<string> {
    if (this._isListening && this.socketPath) {
      return this.socketPath
    }

    // Generate unique socket path in temp directory
    const id = randomUUID().slice(0, 8)
    this.socketPath = join(tmpdir(), `code-atelier-ipc-${id}.sock`)

    // Clean up any stale socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // Non-fatal — socket may be in use
      }
    }

    return new Promise<string>((resolve, reject) => {
      this.server = createServer((client: Socket) => {
        this.clients.add(client)
        bridgeLog.info(`[ipc-bridge] Client connected (total: ${this.clients.size})`)

        let buffer = ''

        client.on('data', (data: Buffer) => {
          buffer += data.toString('utf-8')

          // Process complete NDJSON lines
          let newlineIdx: number
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim()
            buffer = buffer.slice(newlineIdx + 1)

            if (!line) continue

            try {
              const event = JSON.parse(line) as IpcBridgeEvent
              this.handleEvent(event)
            } catch {
              bridgeLog.warn(`[ipc-bridge] Malformed event: ${line.slice(0, 120)}`)
            }
          }
        })

        client.on('close', () => {
          this.clients.delete(client)
          bridgeLog.info(`[ipc-bridge] Client disconnected (total: ${this.clients.size})`)
        })

        client.on('error', (err) => {
          bridgeLog.warn(`[ipc-bridge] Client error: ${err.message}`)
          this.clients.delete(client)
        })
      })

      this.server.on('error', (err) => {
        bridgeLog.error(`[ipc-bridge] Server error: ${err.message}`)
        reject(err)
      })

      this.server.listen(this.socketPath!, () => {
        this._isListening = true
        bridgeLog.info(`[ipc-bridge] Listening on ${this.socketPath}`)
        resolve(this.socketPath!)
      })
    })
  }

  /**
   * Get the socket path (for passing as IPC_SOCKET_PATH to MCP servers).
   */
  getSocketPath(): string | null {
    return this.socketPath
  }

  /**
   * Check if the bridge is actively listening.
   */
  isListening(): boolean {
    return this._isListening
  }

  /**
   * Send data to all connected clients (MCP servers).
   * Used for request-response patterns like ask_user — the Electron main
   * process sends the user's response back to the control-actions MCP server.
   */
  sendToClients(data: IpcBridgeEvent): void {
    const payload = JSON.stringify(data) + '\n'
    for (const client of this.clients) {
      if (!client.destroyed) {
        try {
          client.write(payload)
        } catch (err) {
          bridgeLog.warn(`[ipc-bridge] Failed to write to client: ${(err as Error).message}`)
        }
      }
    }
  }

  /**
   * Send a response to an ask_user request.
   * Convenience wrapper around sendToClients for the common ask_user pattern.
   */
  sendAskUserResponse(requestId: string, response: string): void {
    this.sendToClients({
      type: 'askUserResponse',
      requestId,
      payload: { response },
      timestamp: Date.now()
    })
    bridgeLog.info(`[ipc-bridge] Sent askUserResponse for requestId=${requestId}`)
  }

  /**
   * B-8: Send a memory response back to the requesting plugin/tool.
   * Used when a memory read request returns results from the main process.
   */
  sendMemoryResponse(
    requestId: string,
    result: { memories?: Array<{ content: string; category?: string; tier?: number }> }
  ): void {
    this.sendToClients({
      type: 'memoryResponse',
      requestId,
      payload: result,
      timestamp: Date.now()
    })
    bridgeLog.info(
      `[ipc-bridge] Sent memoryResponse for requestId=${requestId} ` +
        `(${result.memories?.length ?? 0} entries)`
    )
  }

  /**
   * Send a response to a permission_prompt request.
   * Routes the user's approve/deny decision back to the control-actions MCP server.
   */
  sendPermissionResponse(requestId: string, approved: boolean, input?: unknown): void {
    this.sendToClients({
      type: 'permissionResponse',
      requestId,
      payload: { approved, input },
      timestamp: Date.now()
    })
    bridgeLog.info(
      `[ipc-bridge] Sent permissionResponse for requestId=${requestId} approved=${approved}`
    )
  }

  /**
   * Stop the socket server and clean up.
   */
  async stop(): Promise<void> {
    if (!this.server) return

    // Close all client connections
    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this._isListening = false

        // Clean up socket file
        if (this.socketPath && existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath)
          } catch {
            // Non-fatal
          }
        }

        this.server = null
        bridgeLog.info('[ipc-bridge] Stopped')
        resolve()
      })
    })
  }

  // ── Private ──

  private handleEvent(event: IpcBridgeEvent): void {
    bridgeLog.info(`[ipc-bridge] Event: ${event.type}`)

    switch (event.type) {
      case 'plan':
        this.emit('plan', event.payload)
        break
      case 'askUser':
        // Pass requestId so the session can correlate the response
        this.emit('askUser', event.payload, event.requestId)
        break
      case 'memory':
        // B-8: Pass requestId so the handler can send a response back
        this.emit('memory', event.payload, event.requestId)
        break
      case 'memoryResponse':
        // Response flowing back to plugin — already handled via sendToClients
        break
      case 'askUserResponse':
        // Response from Electron → MCP server (handled via sendToClients, not events)
        break
      case 'permission':
        // Permission request from plugin — surface in Electron UI for approval
        this.emit('permission', event.payload, event.requestId)
        break
      case 'permissionResponse':
        // Response from Electron → MCP server (handled via sendToClients, not events)
        break
      case 'fileEdited':
        // File edited notification from plugin — trigger re-indexing
        this.emit('fileEdited', event.payload)
        break
      case 'phaseProgress':
        // Plan phase progress from control-actions server
        this.emit('phaseProgress', event.payload)
        break
      default:
        bridgeLog.warn(`[ipc-bridge] Unknown event type: ${event.type}`)
    }
  }
}

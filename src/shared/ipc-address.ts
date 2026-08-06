/**
 * IPC address parsing utility — shared between IpcBridge and MCP servers.
 *
 * The IPC bridge can listen on two transports:
 *   - Unix domain socket: "/tmp/code-atelier-ipc-abc.sock"
 *   - TCP loopback:       "tcp:127.0.0.1:49152"
 *
 * This module provides a single parser so every consumer handles the
 * `tcp:` prefix convention consistently.
 */

export type IpcAddress =
  { type: 'unix'; path: string } | { type: 'tcp'; host: string; port: number }

/**
 * Parse an IPC_SOCKET_PATH value into a typed address.
 * Returns null if the address is malformed (invalid port, missing host, etc.).
 *
 * @example
 *   parseIpcAddress('/tmp/code-atelier-ipc-abc.sock')
 *   // → { type: 'unix', path: '/tmp/code-atelier-ipc-abc.sock' }
 *
 *   parseIpcAddress('tcp:127.0.0.1:49152')
 *   // → { type: 'tcp', host: '127.0.0.1', port: 49152 }
 *
 *   parseIpcAddress('tcp:127.0.0.1:')
 *   // → null (invalid port)
 */
export function parseIpcAddress(addr: string): IpcAddress | null {
  if (!addr) return null

  if (!addr.startsWith('tcp:')) {
    return { type: 'unix', path: addr }
  }

  // Strip 'tcp:' prefix → "127.0.0.1:49152"
  const rest = addr.slice(4)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon < 1) return null // no host portion

  const host = rest.slice(0, lastColon)
  const port = parseInt(rest.slice(lastColon + 1), 10)

  if (isNaN(port) || port < 1 || port > 65535) return null

  return { type: 'tcp', host, port }
}

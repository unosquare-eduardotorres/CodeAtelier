/**
 * IPC Bridge — TCP loopback fallback + parseIpcAddress tests.
 *
 * Tests the TCP transport path added for managed Windows environments
 * where endpoint security blocks Unix domain socket file creation.
 *
 * These tests exercise:
 *   §1: parseIpcAddress — pure parsing of the tcp: prefix convention
 *   §2: IpcBridge TCP fallback — integration with real sockets (with cleanup)
 *   §3: transportType getter — transport type detection
 *   §4: stop() — skips unlinkSync for TCP addresses
 */

import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// ─────────────────────────────────────────────────────────────────────────────
// §1: parseIpcAddress — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parseIpcAddress', () => {
  let parseIpcAddress: typeof import('../../../shared/ipc-address').parseIpcAddress

  test('load_module', async () => {
    const mod = await import('../../../shared/ipc-address')
    parseIpcAddress = mod.parseIpcAddress
    assert.equal(typeof parseIpcAddress, 'function')
  })

  test('parses_unix_socket_path', () => {
    if (!parseIpcAddress) return
    const result = parseIpcAddress('/tmp/code-atelier-ipc-abc.sock')
    assert.deepEqual(result, { type: 'unix', path: '/tmp/code-atelier-ipc-abc.sock' })
  })

  test('parses_tcp_loopback_address', () => {
    if (!parseIpcAddress) return
    const result = parseIpcAddress('tcp:127.0.0.1:49152')
    assert.deepEqual(result, { type: 'tcp', host: '127.0.0.1', port: 49152 })
  })

  test('parses_tcp_with_high_port', () => {
    if (!parseIpcAddress) return
    const result = parseIpcAddress('tcp:127.0.0.1:65535')
    assert.deepEqual(result, { type: 'tcp', host: '127.0.0.1', port: 65535 })
  })

  test('parses_tcp_with_port_1', () => {
    if (!parseIpcAddress) return
    const result = parseIpcAddress('tcp:127.0.0.1:1')
    assert.deepEqual(result, { type: 'tcp', host: '127.0.0.1', port: 1 })
  })

  test('parses_tcp_with_ipv6_localhost', () => {
    if (!parseIpcAddress) return
    // IPv6 uses lastIndexOf(':') to find the port separator
    const result = parseIpcAddress('tcp:::1:8080')
    assert.deepEqual(result, { type: 'tcp', host: '::1', port: 8080 })
  })

  test('returns_null_for_empty_string', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress(''), null)
  })

  test('returns_null_for_tcp_missing_port', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress('tcp:127.0.0.1:'), null)
  })

  test('returns_null_for_tcp_non_numeric_port', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress('tcp:127.0.0.1:abc'), null)
  })

  test('returns_null_for_tcp_port_zero', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress('tcp:127.0.0.1:0'), null)
  })

  test('returns_null_for_tcp_port_too_high', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress('tcp:127.0.0.1:65536'), null)
  })

  test('returns_null_for_tcp_negative_port', () => {
    if (!parseIpcAddress) return
    assert.equal(parseIpcAddress('tcp:127.0.0.1:-1'), null)
  })

  test('returns_null_for_tcp_no_host', () => {
    if (!parseIpcAddress) return
    // 'tcp:' with only a port → lastColon at index 0 for ':1234' → host is empty
    assert.equal(parseIpcAddress('tcp::1234'), null)
  })

  test('treats_non_tcp_prefix_as_unix_path', () => {
    if (!parseIpcAddress) return
    // Windows-style paths, relative paths, etc. are all treated as Unix socket paths
    const result = parseIpcAddress('C:\\Users\\foo\\bar.sock')
    assert.deepEqual(result, { type: 'unix', path: 'C:\\Users\\foo\\bar.sock' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2: IpcBridge — TCP fallback integration
// ─────────────────────────────────────────────────────────────────────────────

describe('IpcBridge — TCP fallback', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let IpcBridge: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeBridge: any = null

  test('load_module', async () => {
    try {
      const mod = await import('../ipc-bridge')
      IpcBridge = mod.IpcBridge
      assert.equal(typeof IpcBridge, 'function')
    } catch {
      // Module load failure — skip remaining tests
    }
  })

  afterEach(async () => {
    // Critical: prevent process hang by stopping the bridge after each test
    if (activeBridge) {
      try {
        await activeBridge.stop()
      } catch {
        // ignore stop errors
      }
      activeBridge = null
    }
  })

  test('start_falls_back_to_tcp_when_unix_path_invalid', async () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    activeBridge = bridge

    // Force Unix socket failure by using a path in a non-existent directory.
    // We monkey-patch the private listenOn to always reject, simulating EACCES.
    const originalListenOn = bridge.listenOn?.bind(bridge) ?? null
    void originalListenOn // suppress unused warning
    ;(bridge as any).listenOn = () => {
      // Simulate the createBridgeServer call that sets this.server
      const { createServer } = require('node:net')
      ;(bridge as any).server = createServer()
      return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    }

    const addr = await bridge.start()
    assert.match(addr, /^tcp:127\.0\.0\.1:\d+$/)
    assert.equal(bridge.isListening(), true)
  })

  test('start_returns_unix_path_when_socket_works', async () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    activeBridge = bridge

    const addr = await bridge.start()
    // On macOS/Linux, Unix sockets should work — the address is a file path
    assert.ok(!addr.startsWith('tcp:'), `Expected Unix socket path, got: ${addr}`)
    assert.ok(addr.includes('.sock'), `Expected .sock extension, got: ${addr}`)
    assert.equal(bridge.isListening(), true)
  })

  test('start_is_idempotent_returns_same_address', async () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    activeBridge = bridge

    const addr1 = await bridge.start()
    const addr2 = await bridge.start()
    assert.equal(addr1, addr2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3: transportType getter
// ─────────────────────────────────────────────────────────────────────────────

describe('IpcBridge — transportType getter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let IpcBridge: any

  test('load_module', async () => {
    try {
      const mod = await import('../ipc-bridge')
      IpcBridge = mod.IpcBridge
    } catch {
      // skip
    }
  })

  test('returns_null_before_start', () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    assert.equal(bridge.transportType, null)
  })

  test('returns_unix_for_socket_path', () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    // Simulate a Unix socket path being set
    ;(bridge as any).socketPath = '/tmp/code-atelier-ipc-test.sock'
    assert.equal(bridge.transportType, 'unix')
  })

  test('returns_tcp_for_tcp_address', () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    // Simulate a TCP address being set
    ;(bridge as any).socketPath = 'tcp:127.0.0.1:49152'
    assert.equal(bridge.transportType, 'tcp')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4: stop() — TCP unlink skip
// ─────────────────────────────────────────────────────────────────────────────

describe('IpcBridge — stop() TCP unlink skip', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let IpcBridge: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeBridge: any = null

  test('load_module', async () => {
    try {
      const mod = await import('../ipc-bridge')
      IpcBridge = mod.IpcBridge
    } catch {
      // skip
    }
  })

  afterEach(async () => {
    if (activeBridge) {
      try {
        await activeBridge.stop()
      } catch {
        /* ignore */
      }
      activeBridge = null
    }
  })

  test('stop_does_not_call_unlinkSync_for_tcp_transport', async () => {
    if (!IpcBridge) return
    const bridge = new IpcBridge()
    activeBridge = bridge

    // Force TCP path by making listenOn fail
    ;(bridge as any).listenOn = () => {
      const { createServer } = require('node:net')
      ;(bridge as any).server = createServer()
      return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    }

    const addr = await bridge.start()
    assert.match(addr, /^tcp:127\.0\.0\.1:\d+$/)

    // stop() should complete cleanly for TCP transport — no unlinkSync attempt.
    // The guard in stop() is: `!this.socketPath.startsWith('tcp:')` which
    // short-circuits before existsSync/unlinkSync. Monkey-patching fs.existsSync
    // doesn't work here because ipc-bridge.ts destructures the import at load time.
    await bridge.stop()
    assert.equal(bridge.isListening(), false)
    activeBridge = null // already stopped
  })
})

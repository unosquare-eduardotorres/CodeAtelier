/**
 * Electron module stub for IPC handler testing under Node.js/tsx.
 *
 * Intercepts `require('electron')` and `require('electron-log/main')` to
 * redirect them to real CJS mock files (__electron_mock.cjs, __electron_log_mock.cjs).
 * Using real files instead of in-memory mocks lets c8 properly track coverage
 * for modules loaded through the standard CJS pipeline.
 *
 * Usage:
 *   1. `import { setupElectronStub, getHandlers, ... } from './electron-stub'`
 *   2. `setupElectronStub()` — must be called BEFORE importing any IPC module
 *   3. `await import('../../ipc/foo.ipc')` — dynamic import after stub is active
 *   4. `registerFooIpc(mockMainWindow)` — call the register function
 *   5. `getHandlers().get('foo:list')` — access captured handler functions
 */
import Module from 'node:module'
import path from 'node:path'

/** Generic handler function shape used throughout this stub's captured-handler maps. */
type AnyFn = (...args: any[]) => any

// ── Resolved paths to CJS mock files ────────────────────────────────────────

const electronMockPath = path.resolve(__dirname, '__electron_mock.cjs')
const electronLogMockPath = path.resolve(__dirname, '__electron_log_mock.cjs')

// ── Lazy reference to the CJS mock's state ──────────────────────────────────

let _mockModule: any = null

function getMock(): any {
  if (!_mockModule) {
    _mockModule = require(electronMockPath)
  }
  return _mockModule
}

/** All handlers registered via `ipcMain.handle(channel, fn)` */
export function getHandlers(): Map<string, AnyFn> {
  return getMock().__capturedHandlers
}

/**
 * capturedHandlers — legacy Map interface for backward compatibility.
 * After setupElectronStub() is called, this delegates to the CJS mock's map.
 */
export const capturedHandlers = {
  get(channel: string): AnyFn | undefined {
    return getHandlers().get(channel)
  },
  set(channel: string, handler: AnyFn): Map<string, AnyFn> {
    return getHandlers().set(channel, handler)
  },
  has(channel: string): boolean {
    return getHandlers().has(channel)
  },
  keys(): IterableIterator<string> {
    return getHandlers().keys()
  },
  entries(): IterableIterator<[string, AnyFn]> {
    return getHandlers().entries()
  },
  values(): IterableIterator<AnyFn> {
    return getHandlers().values()
  },
  get size(): number {
    return getHandlers().size
  },
  clear(): void {
    getHandlers().clear()
  },
  forEach(fn: (value: AnyFn, key: string) => void): void {
    getHandlers().forEach(fn)
  },
  [Symbol.iterator](): IterableIterator<[string, AnyFn]> {
    return getHandlers().entries()
  }
} as unknown as Map<string, AnyFn>

/** Events sent via BrowserWindow.webContents.send */
export const sentEvents: Array<{ channel: string; data: unknown }> = []

/** Paths passed to `shell.showItemInFolder`, newest last. */
export function getRevealedPaths(): string[] {
  return getMock().__shellRevealed
}

/** Mock event that passes validateSender */
export const mockEvent = {
  senderFrame: { url: 'file:///app/index.html' }
} as unknown as Electron.IpcMainInvokeEvent

/** Mock BrowserWindow instance */
export const mockMainWindow = {
  webContents: {
    send: (channel: string, data: unknown): void => {
      sentEvents.push({ channel, data })
    },
    on: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
    id: 1
  },
  on: () => {},
  removeListener: () => {},
  isDestroyed: () => false,
  isVisible: () => true,
  show: () => {},
  hide: () => {},
  close: () => {},
  focus: () => {}
} as unknown as Electron.BrowserWindow

/** Reset all captured state */
export function resetStub(): void {
  getHandlers().clear()
  getMock().__capturedOnHandlers.clear()
  getMock().__sentEvents.length = 0
  getMock().__shellRevealed.length = 0
  sentEvents.length = 0
}

// ── Module interception ─────────────────────────────────────────────────────

let stubInstalled = false

/**
 * Install the electron module stub. Must be called BEFORE dynamically importing
 * any IPC module that does `import { ipcMain } from 'electron'`.
 *
 * Hooks both `_resolveFilename` and `_load` so c8 can track coverage properly.
 * Safe to call multiple times — only installs once.
 */
export function setupElectronStub(): void {
  if (stubInstalled) return
  stubInstalled = true

  // Pre-load the mock module to initialize its state
  _mockModule = require(electronMockPath)

  // Hook _resolveFilename — primary hook for c8 compatibility
  const origResolve = (Module as any)._resolveFilename
  ;(Module as any)._resolveFilename = function (request: string, ...args: any[]) {
    if (request === 'electron') {
      return electronMockPath
    }
    if (request === 'electron-log/main' || request === 'electron-log') {
      return electronLogMockPath
    }
    return origResolve.call(this, request, ...args)
  }

  // Hook _load — fallback for edge cases
  const origLoad = (Module as any)._load
  ;(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'electron') {
      return _mockModule
    }
    if (request === 'electron-log/main' || request === 'electron-log') {
      return require(electronLogMockPath)
    }
    // Handle Vite ?raw imports for .sql files — read as plain text string
    if (request.endsWith('.sql?raw') || (request.endsWith('.sql') && parent?.filename)) {
      const fs = require('node:fs') as typeof import('node:fs')
      const resolved = request.replace(/\?raw$/, '')
      const absPath = path.resolve(path.dirname(parent.filename), resolved)
      return fs.readFileSync(absPath, 'utf-8')
    }
    return origLoad.call(this, request, parent, isMain)
  }
}

/**
 * Invoke a captured IPC handler with mock event and args.
 * Returns the handler result or throws the handler error.
 */
export async function invokeHandler(channel: string, args?: unknown): Promise<unknown> {
  const handlers = getHandlers()
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(
      `No handler captured for channel: ${channel}. Available: ${[...handlers.keys()].join(', ')}`
    )
  }
  return handler(mockEvent, args)
}

/**
 * Try invoking a handler, catching expected errors (e.g. repository unavailable).
 * Returns { ok: true, result } on success, { ok: false, error } on failure.
 */
export async function tryInvokeHandler(
  channel: string,
  args?: unknown
): Promise<{ ok: true; result: unknown } | { ok: false; error: Error }> {
  try {
    const result = await invokeHandler(channel, args)
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}

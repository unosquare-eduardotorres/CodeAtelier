/**
 * Pre-flight check for better-sqlite3 native module.
 *
 * With better-sqlite3 v13 (N-API), a single prebuilt binary works across
 * Node.js and Electron runtimes. This check remains as defense-in-depth
 * to catch unexpected loading failures in the packaged app.
 */

export interface NativeModuleCheckResult {
  ok: boolean
  error?: string
}

export function checkNativeModuleCompat(): NativeModuleCheckResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module import
    const Database = require('better-sqlite3')
    const testDb = new Database(':memory:')
    testDb.close()
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `better-sqlite3 load failed: ${msg.slice(0, 300)}`
    }
  }
}

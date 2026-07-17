/**
 * Pre-flight check for better-sqlite3 native module compatibility.
 *
 * MCP servers run as plain `node` but the native module may be rebuilt
 * for Electron's ABI by `electron-builder install-app-deps`. When the
 * ABI doesn't match, require('better-sqlite3') throws at module load.
 *
 * This utility provides a clear, actionable error message instead of
 * an opaque native module crash.
 */

export function checkNativeModuleCompat(): { ok: boolean; error?: string } {
  try {
    require('better-sqlite3')
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('NODE_MODULE_VERSION') ||
      msg.includes('ABI') ||
      msg.includes('was compiled against')
    ) {
      return {
        ok: false,
        error:
          `better-sqlite3 ABI mismatch: native module was compiled for a different Node.js version. ` +
          `Run "npx electron-builder install-app-deps" (for Electron) or "npm rebuild better-sqlite3" (for system Node).`
      }
    }
    return { ok: false, error: `better-sqlite3 load failed: ${msg.slice(0, 200)}` }
  }
}

/**
 * Injected into every MCP server entry chunk by the `mcp-server-electron-shim`
 * vite plugin (see electron.vite.config.ts).
 *
 * MCP servers are spawned as standalone child processes using the app binary
 * under ELECTRON_RUN_AS_NODE=1 (see src/main/services/node-runtime.ts). In that
 * mode `process.versions.electron` is still set, but the `electron` module is
 * NOT resolvable: in dev it resolves to the npm package's path string, and in a
 * packaged app it is pruned entirely (`electron` is a devDependency and both
 * build-mac.sh and build-win.sh run `npm prune --omit=dev`). `electron-log/main`
 * requires `electron` internally, so importing the logger throws.
 *
 * The guard therefore covers both "not Electron at all" and "Electron binary
 * running in Node mode", while leaving the real main process untouched.
 */
export const MCP_STANDALONE_SHIM = [
  '// ── MCP standalone-process shim ──────────────────────────────────',
  '// MCP servers run as standalone child processes (plain `node`, or the app',
  '// binary under ELECTRON_RUN_AS_NODE=1) where `electron` and `electron-log`',
  '// are unavailable. Intercept require() and return lightweight mocks. The',
  '// real Electron main process sets neither condition and is unaffected.',
  'if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {',
  '  var _M = require("module"), _origLoad = _M._load, _noop = function() {};',
  '  var _mkScope = function() { return { info: _noop, warn: _noop, error: _noop, debug: _noop, verbose: _noop, log: _noop, silly: _noop, scope: _mkScope }; };',
  '  var _mockLog = { info: _noop, warn: _noop, error: _noop, debug: _noop, verbose: _noop, log: _noop, silly: _noop, scope: function() { return _mkScope(); }, transports: { file: { level: false, maxSize: 0, format: "" }, console: { level: false, format: "" } }, errorHandler: { startCatching: _noop } };',
  '  _mockLog.default = _mockLog;',
  '  var _mockElectron = { app: { getPath: function(n) { return process.env.DB_PATH || "/tmp/mcp-" + n; }, getName: function() { return "MCP"; }, getVersion: function() { return "0.0.0"; }, isPackaged: false, getAppPath: function() { return __dirname; }, on: _noop, quit: _noop }, ipcMain: { handle: _noop, removeHandler: _noop, on: _noop }, BrowserWindow: { getAllWindows: function() { return []; }, getFocusedWindow: function() { return null; } }, dialog: {}, shell: {}, nativeTheme: { shouldUseDarkColors: true, on: _noop }, safeStorage: { isEncryptionAvailable: function() { return false; }, encryptString: _noop, decryptString: function() { return ""; } } };',
  '  _M._load = function(r, p, m) {',
  '    if (r === "electron") return _mockElectron;',
  '    if (r === "electron-log/main" || r === "electron-log") return _mockLog;',
  '    return _origLoad.apply(this, arguments);',
  '  };',
  '}',
  '// ── End shim ────────────────────────────────────────────────────────',
  ''
].join('\n')

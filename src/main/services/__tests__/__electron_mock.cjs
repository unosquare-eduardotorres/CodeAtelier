/**
 * CJS module that provides mock electron exports.
 * Used by the electron-stub.ts Module._resolveFilename hook to redirect
 * `require('electron')` to this file, enabling c8 coverage tracking.
 */
'use strict'

const capturedHandlers = new Map()
const capturedOnHandlers = new Map()
const sentEvents = []

const noop = function() {}
const noopObj = new Proxy({}, { get: () => noop })

const mockWebContents = {
  send: function(channel, data) { sentEvents.push({ channel, data }) },
  on: noop,
  removeListener: noop,
  removeAllListeners: noop,
  id: 1,
}

const mockIpcMain = {
  handle: function(channel, handler) { capturedHandlers.set(channel, handler) },
  removeHandler: noop,
  on: function(channel, handler) { capturedOnHandlers.set(channel, handler) },
}

const mockBrowserWindow = {
  getAllWindows: function() {
    return [{ 
      webContents: mockWebContents,
      on: noop,
      removeListener: noop,
      isDestroyed: function() { return false },
    }]
  },
  getFocusedWindow: function() { return null },
}

const mockApp = {
  getPath: function(name) { return '/tmp/electron-test/' + name },
  getName: function() { return 'AgentStudio-test' },
  getVersion: function() { return '1.0.0-test' },
  isPackaged: false,
  getAppPath: function() { return '/tmp/electron-test' },
  on: noop,
  quit: noop,
}

module.exports = {
  ipcMain: mockIpcMain,
  BrowserWindow: mockBrowserWindow,
  app: mockApp,
  dialog: {
    showOpenDialog: async function() { return { canceled: true, filePaths: [] } },
    showSaveDialog: async function() { return { canceled: true } },
    showMessageBox: async function() { return { response: 0 } },
  },
  shell: {
    openExternal: async function() {},
    openPath: async function() { return { error: '' } },
  },
  nativeTheme: {
    shouldUseDarkColors: true,
    themeSource: 'system',
    on: noop,
  },
  clipboard: { writeText: noop, readText: function() { return '' } },
  screen: {
    getPrimaryDisplay: function() { return { workAreaSize: { width: 1920, height: 1080 } } },
  },
  // Internal access for test assertions
  __capturedHandlers: capturedHandlers,
  __capturedOnHandlers: capturedOnHandlers,
  __sentEvents: sentEvents,
  // Default export (electron package normally exports binary path string)
  default: '/usr/local/bin/electron',
}

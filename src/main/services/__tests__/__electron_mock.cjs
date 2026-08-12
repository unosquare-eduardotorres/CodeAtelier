/**
 * CJS module that provides mock electron exports.
 * Used by the electron-stub.ts Module._resolveFilename hook to redirect
 * `require('electron')` to this file, enabling c8 coverage tracking.
 */
'use strict'

const capturedHandlers = new Map()
const capturedOnHandlers = new Map()
const sentEvents = []
/** powerMonitor listeners, so tests can fire 'resume'/'suspend' synthetically. */
const powerMonitorListeners = new Map()
/**
 * Native (Squirrel) autoUpdater listeners. Array-backed, unlike the
 * electron-updater double in auto-update-service.test.ts: the staging fix
 * registers more than one listener and dropping any of them would hide bugs.
 */
const autoUpdaterListeners = new Map()
/** Paths passed to shell.showItemInFolder, so tests can assert what was revealed. */
const shellRevealed = []

const noop = function () {
  /* no-op mock method */
}

const mockWebContents = {
  send: function (channel, data) {
    sentEvents.push({ channel, data })
  },
  on: noop,
  removeListener: noop,
  removeAllListeners: noop,
  id: 1
}

const mockIpcMain = {
  handle: function (channel, handler) {
    capturedHandlers.set(channel, handler)
  },
  removeHandler: noop,
  on: function (channel, handler) {
    capturedOnHandlers.set(channel, handler)
  }
}

const mockBrowserWindow = {
  getAllWindows: function () {
    return [
      {
        webContents: mockWebContents,
        on: noop,
        removeListener: noop,
        isDestroyed: function () {
          return false
        }
      }
    ]
  },
  getFocusedWindow: function () {
    return null
  }
}

// ── Notification mock for OS notification tests ──
let notificationSupportedFlag = true
let lastCreatedNotification = null

function recordLastCreatedNotification(instance) {
  lastCreatedNotification = instance
}

class MockNotification {
  constructor(opts) {
    this.title = opts.title || ''
    this.subtitle = opts.subtitle
    this.body = opts.body || ''
    this.silent = opts.silent ?? true
    this.sound = opts.sound
    this.groupId = opts.groupId
    this.urgency = opts.urgency
    this._listeners = {}
    this._shown = false
    this._closed = false
    recordLastCreatedNotification(this)
  }
  static isSupported() {
    return notificationSupportedFlag
  }
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = []
    this._listeners[event].push(handler)
  }
  show() {
    this._shown = true
  }
  close() {
    this._closed = true
    for (const handler of this._listeners['close'] || []) handler()
  }
}

// ── Dock mock ──
let lastDockBounceType = null

const mockApp = {
  getPath: function (name) {
    return '/tmp/electron-test/' + name
  },
  getName: function () {
    return 'AgentStudio-test'
  },
  getVersion: function () {
    return '1.0.0-test'
  },
  isPackaged: false,
  getAppPath: function () {
    return '/tmp/electron-test'
  },
  on: noop,
  quit: noop,
  dock: {
    bounce: function (type) {
      lastDockBounceType = type
    },
    setBadge: noop
  }
}

module.exports = {
  ipcMain: mockIpcMain,
  BrowserWindow: mockBrowserWindow,
  app: mockApp,
  dialog: {
    showOpenDialog: async function () {
      return { canceled: true, filePaths: [] }
    },
    showSaveDialog: async function () {
      return { canceled: true }
    },
    showMessageBox: async function () {
      return { response: 0 }
    }
  },
  shell: {
    openExternal: async function () {
      /* no-op mock — never actually opens a URL */
    },
    openPath: async function () {
      return { error: '' }
    },
    showItemInFolder: function (fullPath) {
      shellRevealed.push(fullPath)
    }
  },
  nativeTheme: {
    shouldUseDarkColors: true,
    themeSource: 'system',
    on: noop
  },
  safeStorage: {
    encryptString: function (str) {
      // Simple reversible mock: prepend 'ENC:' and return as Buffer
      return Buffer.from('ENC:' + str)
    },
    decryptString: function (buf) {
      const str = buf.toString()
      if (!str.startsWith('ENC:')) throw new Error('Mock: cannot decrypt non-mock data')
      return str.slice(4)
    },
    isEncryptionAvailable: function () {
      return true
    }
  },
  clipboard: {
    writeText: noop,
    readText: function () {
      return ''
    }
  },
  screen: {
    getPrimaryDisplay: function () {
      return { workAreaSize: { width: 1920, height: 1080 } }
    }
  },
  powerMonitor: {
    on: function (event, fn) {
      if (!powerMonitorListeners.has(event)) powerMonitorListeners.set(event, [])
      powerMonitorListeners.get(event).push(fn)
      return this
    },
    removeListener: function (event, fn) {
      const list = powerMonitorListeners.get(event)
      if (list) {
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
      return this
    }
  },
  autoUpdater: {
    on: function (event, fn) {
      if (!autoUpdaterListeners.has(event)) autoUpdaterListeners.set(event, [])
      autoUpdaterListeners.get(event).push(fn)
      return this
    },
    removeListener: function (event, fn) {
      const list = autoUpdaterListeners.get(event)
      if (list) {
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
      return this
    },
    setFeedURL: noop,
    checkForUpdates: noop,
    quitAndInstall: noop
  },
  __autoUpdaterMock: {
    emit: function (event, payload) {
      for (const fn of (autoUpdaterListeners.get(event) || []).slice()) fn(payload)
    },
    listenerCount: function (event) {
      return (autoUpdaterListeners.get(event) || []).length
    },
    reset: function () {
      autoUpdaterListeners.clear()
    }
  },
  __powerMonitorMock: {
    emit: function (event) {
      for (const fn of powerMonitorListeners.get(event) || []) fn()
    },
    listenerCount: function (event) {
      return (powerMonitorListeners.get(event) || []).length
    },
    reset: function () {
      powerMonitorListeners.clear()
    }
  },
  Notification: MockNotification,
  // Internal access for test assertions
  __shellRevealed: shellRevealed,
  __capturedHandlers: capturedHandlers,
  __capturedOnHandlers: capturedOnHandlers,
  __sentEvents: sentEvents,
  __notificationMock: {
    get lastCreated() {
      return lastCreatedNotification
    },
    get lastDockBounceType() {
      return lastDockBounceType
    },
    get supported() {
      return notificationSupportedFlag
    },
    set supported(v) {
      notificationSupportedFlag = v
    },
    reset() {
      lastCreatedNotification = null
      lastDockBounceType = null
      notificationSupportedFlag = true
    }
  },
  // Default export (electron package normally exports binary path string)
  default: '/usr/local/bin/electron'
}

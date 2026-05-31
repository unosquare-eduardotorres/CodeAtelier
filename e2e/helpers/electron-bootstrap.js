/**
 * Bootstrap script for launching Electron with remote debugging enabled.
 *
 * Electron 41+ rejects --remote-debugging-port as a CLI flag.
 * This script is loaded via -r (preload) and sets the flag using the
 * Electron API before the main app script runs.
 *
 * Usage:
 *   Electron -r e2e/helpers/electron-bootstrap.js out/main/index.js
 *
 * The CDP port is read from the E2E_CDP_PORT environment variable.
 */
'use strict'

const cdpPort = process.env.E2E_CDP_PORT || '19222'

try {
  const { app } = require('electron')
  if (app && app.commandLine) {
    app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
  } else {
    console.error('[e2e-bootstrap] electron.app not available at -r time')
  }
} catch (e) {
  console.error('[e2e-bootstrap] Failed to set remote-debugging-port:', e.message)
}

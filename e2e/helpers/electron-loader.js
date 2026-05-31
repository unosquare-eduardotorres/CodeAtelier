/**
 * Custom Electron loader that patches --remote-debugging-port for Electron 41+.
 *
 * Electron 41 rejects --remote-debugging-port as a CLI arg. It must be set via
 * app.commandLine.appendSwitch() before the app is ready.
 *
 * This loader intercepts the arg from process.argv, strips it, and re-applies it
 * via the Electron API so Playwright can attach its CDP connection.
 */
const { app } = require('electron')

// Extract --remote-debugging-port from argv (Playwright passes it)
const rdpArgIndex = process.argv.findIndex((a) => a.startsWith('--remote-debugging-port='))
if (rdpArgIndex !== -1) {
  const port = process.argv[rdpArgIndex].split('=')[1]
  // Remove it from argv so Electron doesn't choke
  process.argv.splice(rdpArgIndex, 1)
  // Set it via the proper Electron API
  app.commandLine.appendSwitch('remote-debugging-port', port)
}

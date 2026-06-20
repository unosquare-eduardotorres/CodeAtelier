/**
 * Shared Playwright fixture for Electron E2E tests.
 *
 * Extracts the ~50-line CDP boilerplate duplicated across all existing tests
 * into a reusable fixture that:
 *   1. Spawns Electron with remote debugging via electron-bootstrap.js
 *   2. Discovers the page-level WebSocket target from /json/list
 *   3. Connects Playwright via chromium.connect()
 *   4. Exposes a ready `electronPage` to every test
 *   5. Auto-cleans (browser.close + process kill) on teardown
 *
 * Usage:
 *   import { test, expect } from '../helpers/electron-fixture'
 *   test('my test', async ({ electronPage }) => { ... })
 */
import { test as base, chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { resolve } from 'path'

const ELECTRON_BIN = resolve(
  __dirname,
  '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const BOOTSTRAP = resolve(__dirname, 'electron-bootstrap.js')

// ── Helpers ────────────────────────────────────────────────────────────────

/** Poll CDP /json/version until it responds or timeout fires. */
async function waitForCDP(port: number, timeoutMs = 25_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (resp.ok) return
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`)
}

/** Discover the page-level WebSocket URL from CDP /json/list. */
async function findPageTarget(port: number, timeoutMs = 15_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await resp.json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
        url: string
      }>
      const pageTarget = targets.find((t) => t.type === 'page')
      if (pageTarget?.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl
      }
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`No page target found in CDP on port ${port} after ${timeoutMs}ms`)
}

/** Gracefully kill a child process, with SIGKILL fallback. */
async function killProcess(proc: ChildProcess): Promise<void> {
  proc.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 2_000))
  if (!proc.killed) proc.kill('SIGKILL')
}

// ── Fixture ────────────────────────────────────────────────────────────────

type ElectronFixtures = {
  /** A ready-to-use Playwright Page connected to the Electron renderer. */
  electronPage: Page
  /** The CDP port used for this test worker. */
  cdpPort: number
}

export const test = base.extend<ElectronFixtures>({
  cdpPort: [19222, { option: true }],

  electronPage: async ({ cdpPort }, use) => {
    // Strip ELECTRON_RUN_AS_NODE so Electron launches in full GUI mode
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.E2E_CDP_PORT = String(cdpPort)
    env.NODE_ENV = 'test'

    const proc = spawn(ELECTRON_BIN, ['-r', BOOTSTRAP, MAIN_ENTRY], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Log stderr for debugging (skip DevTools noise)
    proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg && !msg.includes('DevTools')) {
        console.log(`  [electron:err] ${msg}`)
      }
    })

    let browser: ReturnType<typeof chromium.connect> extends Promise<infer B> ? B : never
    let page: Page

    try {
      await waitForCDP(cdpPort)
      const pageWsUrl = await findPageTarget(cdpPort)
      browser = await chromium.connect(pageWsUrl, { timeout: 30_000 })

      const contexts = browser.contexts()
      const ctx = contexts[0]
      if (!ctx) throw new Error('No browser context found after CDP connect')

      page = ctx.pages()[0] ?? (await ctx.newPage())
      await page.waitForLoadState('domcontentloaded')
      // Let initial renders and animations settle
      await page.waitForTimeout(3_000)
    } catch (err) {
      await killProcess(proc)
      throw err
    }

    await use(page)

    // Teardown
    await browser.close().catch(() => {})
    await killProcess(proc)
  }
})

export { expect } from '@playwright/test'

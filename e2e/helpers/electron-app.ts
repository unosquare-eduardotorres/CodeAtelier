import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'
import { resolve } from 'path'
import { mkdirSync } from 'fs'

const SCREENSHOT_DIR = resolve(__dirname, '../screenshots')

/** Ensure screenshot output directory exists */
export function ensureScreenshotDir(): void {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

/** Launch the Electron app from built output */
export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const mainEntry = resolve(__dirname, '../../out/main/index.js')

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Allow initial renders and animations to settle
  await page.waitForTimeout(2000)

  return { app, page }
}

/** Take a full-page screenshot with a consistent naming convention */
export async function screenshot(page: Page, name: string): Promise<string> {
  const path = `${SCREENSHOT_DIR}/${name}.png`
  await page.screenshot({ path, fullPage: true })
  return path
}

/** Click a button by its aria-label and wait for UI to settle */
export async function clickByLabel(page: Page, label: string): Promise<void> {
  await page.click(`[aria-label="${label}"]`)
  await page.waitForTimeout(500)
}

/** Click an element matching a text pattern and wait */
export async function clickByText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().click()
  await page.waitForTimeout(500)
}

/** Wait for a selector to appear before proceeding */
export async function waitForSelector(page: Page, selector: string, timeout = 5000): Promise<void> {
  await page.waitForSelector(selector, { timeout })
}

/**
 * H3 FIX: Pin parallelBuildAgents=1 in e2e tests to prevent nondeterministic
 * parallel scheduling from breaking shim-based blueprint expectations.
 * Call this in blueprint e2e test setup before triggering build operations.
 */
export async function pinSequentialBuild(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { api: { setAppPreference: (args: { key: string; value: string }) => Promise<void> } }).api.setAppPreference({
      key: 'parallel_build_agents',
      value: '1'
    })
  ).catch(() => {
    // Swallow if preload API not yet available (page not fully loaded)
  })
}

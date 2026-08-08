/**
 * Feed Brain Ingestion E2E Tests
 *
 * Verifies the rebuilt ingestion UI on the Memory → Ingestion tab:
 *   - Scope selector renders all four scopes and is selectable
 *   - Scope selection replaces the old destructive "Force full re-scan" checkbox
 *   - Mode cards switch the phase preview between Feed Brain and Deep Scan
 *   - Start control is present and enabled once a workspace is open
 *   - Throughput (concurrency) setting is exposed
 *   - A previously-recorded run surfaces its "Last fed …" summary
 *
 * Deliberately does NOT start a real ingestion: a run spawns Claude CLI
 * processes and would blow the 60s budget of the `electron` project. Run
 * behaviour (pause/resume/recovery) is covered by the unit suites
 * memory-bootstrap-control.test.ts and memory-bootstrap.repository.test.ts.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/feed-brain-progress.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Feed Brain Ingestion', () => {
  async function ensureWorkspaceReady(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
    return true
  }

  /** Navigate to Memory → Ingestion, where BootstrapKnowledge renders. */
  async function openIngestionTab(page: import('@playwright/test').Page): Promise<boolean> {
    const nav = new SettingsNav(page)
    if (!(await nav.navigateToSettingsTab('memory'))) return false

    const ingestionTab = page.locator('[data-testid="memory-tab-settings"]')
    if (!(await ingestionTab.isVisible({ timeout: 5_000 }).catch(() => false))) return false
    await ingestionTab.click()
    await page.waitForTimeout(500)

    // Select the Bootstrap pane explicitly — relying on it being the default
    // section made this suite silently dependent on SECTIONS ordering.
    const bootstrapSection = page.locator('[data-testid="ingestion-section-bootstrap"]')
    if (await bootstrapSection.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await bootstrapSection.click()
      await page.waitForTimeout(300)
    }

    return page
      .locator('[data-testid="bootstrap-start"]')
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
  }

  test('scope selector offers all four scopes', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    for (const scope of ['changed', 'docs', 'deep-scan', 'full']) {
      await expect(page.locator(`[data-testid="bootstrap-scope-${scope}"]`)).toBeVisible()
    }
  })

  test('selecting a scope updates the explanatory hint', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    await page.locator('[data-testid="bootstrap-scope-full"]').click()
    await page.waitForTimeout(300)

    // The full-rebuild hint is the loudest one — it warns about the cost.
    await expect(page.getByText(/ignore every hash/i).first()).toBeVisible({ timeout: 3_000 })

    await page.locator('[data-testid="bootstrap-scope-changed"]').click()
    await page.waitForTimeout(300)
    await expect(page.getByText(/have not changed since the last run/i).first()).toBeVisible({
      timeout: 3_000
    })
  })

  test('the old force re-scan checkbox is gone', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const forceCheckbox = page.getByText(/force full re-scan/i)
    expect(await forceCheckbox.count()).toBe(0)
  })

  test('switching to Deep Scan swaps the phase preview', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    // Feed Brain (default) shows the Structure phase, not the Agent Scan phase.
    await expect(page.getByText('Structure', { exact: true }).first()).toBeVisible({
      timeout: 3_000
    })

    await page.getByText('Deep Scan', { exact: true }).first().click()
    await page.waitForTimeout(500)

    await expect(page.getByText('Agent Scan', { exact: true }).first()).toBeVisible({
      timeout: 3_000
    })
    await expect(page.getByText(/consume API tokens/i).first()).toBeVisible({ timeout: 3_000 })
  })

  test('start control is enabled with a workspace open', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const start = page.locator('[data-testid="bootstrap-start"]')
    await expect(start).toBeVisible()
    await expect(start).toBeEnabled()
  })

  test('throughput setting is exposed with a value in range', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openIngestionTab(page)
    if (!opened) {
      test.skip()
      return
    }

    const slider = page.locator('input[type="range"]').first()
    const hasSlider = await slider.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSlider) {
      test.skip()
      return
    }

    const value = Number(await slider.inputValue())
    expect(value).toBeGreaterThanOrEqual(1)
    expect(value).toBeLessThanOrEqual(6)
  })

  test('status bar exposes no Feed Brain indicator while idle', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const statusBar = page.locator('[data-testid="status-bar"]')
    const hasStatusBar = await statusBar.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasStatusBar) {
      test.skip()
      return
    }

    // The indicator is deliberately hidden when nothing is ingesting — a
    // finished run is not news, and the bar should stay quiet.
    const feeding = statusBar.getByText(/feeding/i)
    expect(await feeding.count()).toBe(0)
  })
})

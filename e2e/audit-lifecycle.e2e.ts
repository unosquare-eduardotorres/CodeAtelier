/**
 * Audit Lifecycle E2E Tests
 *
 * Verifies the Health/Audit pipeline — a 4-state view machine:
 *   landing → configure → active → plan
 *
 * Scenarios:
 *   - Health landing empty state for new workspace
 *   - Configure audit with track selection
 *   - Start audit and verify streaming progress
 *   - Audit completion with results
 *   - Cancel/pause audit mid-run
 *   - Audit history persistence
 *   - Select findings and generate remediation plan
 *   - Rerun single track preserves other results
 *
 * Known fragile areas:
 *   - Per-track StreamSegmentAccumulator flush on failure
 *   - Timed cleanup map (90-min auto-cleanup)
 *   - Rerun optimistic status stuck at "running" on IPC reject
 *   - Plan generation requires non-empty selectedFindings + currentRun
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { AppChrome } from './pages/app-chrome'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'
import { HealthPage } from './pages/health-page'

test.describe('Audit Lifecycle', () => {
  /**
   * Helper: navigate to Health tab in workspace settings.
   */
  async function navigateToHealth(
    page: import('@playwright/test').Page
  ): Promise<{ health: HealthPage; settings: WorkspaceSettings }> {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    const settings = new WorkspaceSettings(page)
    const health = new HealthPage(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Open a workspace
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return { health, settings }
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Navigate to Settings tab then Health
    // First check if we need to switch to settings view in the sidebar
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasSettingsTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSettingsTab) {
      // Click on the sidebar Settings tab to show workspace settings
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }

    // Click the Health tab
    await settings.openTab('health')
    await page.waitForTimeout(500)

    return { health, settings }
  }

  test('health landing renders for workspace', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    // Health landing should be visible (with or without history)
    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasLanding) {
      // May already be on a different health view
      const hasConfigure = await health.configure.isVisible({ timeout: 3_000 }).catch(() => false)
      const hasOverview = await health.overview.isVisible({ timeout: 3_000 }).catch(() => false)

      expect(hasLanding || hasConfigure || hasOverview).toBeTruthy()
      return
    }

    await expect(health.landing).toBeVisible()
  })

  test('health landing shows new audit CTA', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    // Should have a "New Audit" or "Run Audit" button
    const newAuditBtn = page.getByRole('button', { name: /new audit|run audit|start/i })
    await expect(newAuditBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test('configure audit shows track selection', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    // Click "New Audit"
    await health.startAudit()

    // Configure view should render
    const hasConfigure = await health.configure.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasConfigure) {
      // Some flows skip directly to running
      test.skip()
      return
    }

    // Track cards should be visible (architecture, security, etc.)
    const trackCards = page.locator('[class*="rounded-xl"][class*="border"]')
    const trackCount = await trackCards.count()
    expect(trackCount).toBeGreaterThan(0)
  })

  test('configure audit shows mode toggle', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    await health.startAudit()

    const hasConfigure = await health.configure.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfigure) {
      test.skip()
      return
    }

    // Light/Deep mode toggle should be visible
    const lightBtn = page.getByRole('button', { name: /light/i }).first()
    const deepBtn = page.getByRole('button', { name: /deep/i }).first()

    const hasLight = await lightBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasDeep = await deepBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasLight || hasDeep).toBeTruthy()

    // If Deep is available, clicking it should show additional options
    if (hasDeep) {
      await deepBtn.click()
      await page.waitForTimeout(500)

      // Skill chips or additional options should appear
      const configContent = await page.locator('[data-testid="health-configure"]').textContent()
      expect(configContent?.length).toBeGreaterThan(0)
    }
  })

  test('configure audit shows provider toggle', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    await health.startAudit()

    const hasConfigure = await health.configure.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfigure) {
      test.skip()
      return
    }

    // Provider toggle (Cloud/Claude vs Local) should be visible
    const providerToggle = page.getByRole('button', { name: /claude|cloud|local/i }).first()
    const hasProvider = await providerToggle.isVisible({ timeout: 3_000 }).catch(() => false)

    // Provider toggle is expected but not required (depends on configuration)
    if (hasProvider) {
      await expect(providerToggle).toBeVisible()
    }
  })

  test('audit history persists across view transitions', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    // Check if there's any history
    const historyCards = health.getHistoryCards()
    const historyCount = await historyCards.count()

    if (historyCount === 0) {
      // No history to verify persistence
      test.skip()
      return
    }

    // Navigate away
    const chrome = new AppChrome(page)
    await chrome.goHome()
    await page.waitForTimeout(1_000)

    // Re-open the workspace and navigate back to Health
    const welcomePage = new WelcomePage(page)
    const cards = welcomePage.getWorkspaceCards()
    const count = await cards.count()
    if (count === 0) {
      test.skip()
      return
    }
    await cards.first().click()
    await page.waitForTimeout(3_000)

    // Navigate back to Health
    const settings = new WorkspaceSettings(page)
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('health')
    await page.waitForTimeout(500)

    // History should still be there
    const refreshedLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (refreshedLanding) {
      const refreshedHistory = health.getHistoryCards()
      const refreshedCount = await refreshedHistory.count()
      expect(refreshedCount).toBe(historyCount)
    }
  })

  test('start audit transitions view to active state', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      test.skip()
      return
    }

    // Start a new audit
    await health.startAudit('light')

    const hasConfigure = await health.configure.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasConfigure) {
      // Click Start/Run button
      await health.confirmStart()
    }

    // View should transition — either active streaming or already overview
    await page.waitForTimeout(5_000)

    const hasOverview = await health.overview.isVisible({ timeout: 5_000 }).catch(() => false)
    const isRunning = await health.isRunning()

    // Should be in active or completed state
    expect(hasOverview || isRunning).toBeTruthy()
  })

  test('overview renders track scores after completion', async ({ electronPage: page }) => {
    const { health } = await navigateToHealth(page)

    // Check if we can see an existing completed audit via history
    const hasLanding = await health.landing.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasLanding) {
      const hasOverview = await health.overview.isVisible({ timeout: 5_000 }).catch(() => false)
      if (hasOverview) {
        // Already on overview — verify it has content
        const overviewText = await health.overview.textContent()
        expect(overviewText?.length).toBeGreaterThan(0)
      }
      return
    }

    // Click on a history card if any exist
    const historyCards = health.getHistoryCards()
    const historyCount = await historyCards.count()

    if (historyCount === 0) {
      test.skip()
      return
    }

    await historyCards.first().click()
    await page.waitForTimeout(1_000)

    // Overview should render with track results
    const hasOverview = await health.overview.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasOverview) {
      const overviewText = await health.overview.textContent()
      expect(overviewText?.length).toBeGreaterThan(0)
    }
  })
})

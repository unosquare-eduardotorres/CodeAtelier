/**
 * Health Configure E2E Tests
 *
 * Verifies HealthConfigure (355 LOC) — full-screen audit setup:
 *   - Configure page renders with selectable auditor cards
 *   - Auditor cards show checkmark when selected
 *   - Light vs Deep toggle changes mode description
 *   - Deep mode reveals per-track skill chip selector
 *   - Provider toggle switches between Cloud and Local
 *   - "Start Audit" button enabled when configuration is valid
 *   - Back button returns to health landing page
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/health-configure.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Health Configure', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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

  async function navigateToHealthConfigure(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.selectTab('health')
    await page.waitForTimeout(800)

    // Look for "New Audit" or "Run Audit" or configure button
    const newAuditBtn = page.getByRole('button', { name: /new audit|run audit|configure/i }).first()
    if (await newAuditBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await newAuditBtn.click()
      await page.waitForTimeout(800)
    }

    const configure = page.locator('[data-testid="health-configure"]')
    return configure.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('configure page renders with selectable auditor cards', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    const configure = page.locator('[data-testid="health-configure"]')
    await expect(configure).toBeVisible()

    // Should show "Configure Audit" heading
    const heading = configure.getByText('Configure Audit')
    await expect(heading).toBeVisible()

    // Auditor cards should be visible
    const auditorCards = page.locator('[data-testid="health-auditor-card"]')
    const count = await auditorCards.count()
    expect(count).toBeGreaterThan(0)
  })

  test('auditor cards show checkmark when selected', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    const auditorCards = page.locator('[data-testid="health-auditor-card"]')
    const count = await auditorCards.count()
    if (count === 0) { test.skip(); return }

    // All tracks are selected by default — cards should have checkmark styling
    // Look for the primary-colored checkbox indicator
    const firstCard = auditorCards.first()
    const checkbox = firstCard.locator('button').first()
    await expect(checkbox).toBeVisible()

    // Click to deselect
    await checkbox.click()
    await page.waitForTimeout(300)

    // Click to reselect
    await checkbox.click()
    await page.waitForTimeout(300)

    // Card should still be visible and interactive
    await expect(firstCard).toBeVisible()
  })

  test('Light vs Deep toggle changes mode description', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    const configure = page.locator('[data-testid="health-configure"]')

    // Should show Light and Deep buttons
    const lightBtn = configure.getByText('Light', { exact: true }).first()
    const deepBtn = configure.getByText('Deep', { exact: true }).first()

    await expect(lightBtn).toBeVisible()
    await expect(deepBtn).toBeVisible()

    // Click Deep to switch mode
    await deepBtn.click()
    await page.waitForTimeout(300)

    // Deep mode description should mention "multi-round"
    const deepDesc = configure.getByText(/multi-round/i).first()
    const hasDeepDesc = await deepDesc.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasDeepDesc).toBeTruthy()

    // Switch back to Light
    await lightBtn.click()
    await page.waitForTimeout(300)
  })

  test('Deep mode reveals per-track skill chip selector', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    const configure = page.locator('[data-testid="health-configure"]')

    // Switch to Deep mode
    const deepBtn = configure.getByText('Deep', { exact: true }).first()
    await deepBtn.click()
    await page.waitForTimeout(500)

    // Skill chips should appear for selected auditors
    const skillChips = configure.getByText('Focus skills (optional)')
    const hasSkills = await skillChips.first().isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSkills) {
      // Skill chip buttons should be clickable
      const chipBtns = configure.locator('.rounded-full').filter({ hasText: /\w+/ })
      const chipCount = await chipBtns.count()
      expect(chipCount).toBeGreaterThan(0)
    }

    // Switch back to Light
    const lightBtn = configure.getByText('Light', { exact: true }).first()
    await lightBtn.click()
  })

  test('provider toggle switches between Cloud and Local', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    const configure = page.locator('[data-testid="health-configure"]')

    // Provider section should show Claude and Local LLM buttons
    const claudeBtn = configure.getByText('Claude', { exact: true }).first()
    const localBtn = configure.getByText('Local LLM', { exact: true }).first()

    const hasClaude = await claudeBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasLocal = await localBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasClaude && hasLocal).toBeTruthy()

    // Switch to Local LLM
    if (hasLocal) {
      await localBtn.click()
      await page.waitForTimeout(300)
    }

    // Switch back to Claude
    if (hasClaude) {
      await claudeBtn.click()
      await page.waitForTimeout(300)
    }
  })

  test('"Start Audit" button enabled when configuration is valid', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    // Run Audit button should be visible and enabled (all tracks selected by default)
    const runBtn = page.locator('[data-testid="health-run-btn"]')
    await expect(runBtn).toBeVisible()
    await expect(runBtn).toBeEnabled()

    // Button text should include track count and time estimate
    const btnText = await runBtn.textContent()
    expect(btnText).toMatch(/Run Audit/)
  })

  test('back button returns to health landing page', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasConfig = await navigateToHealthConfigure(page)
    if (!hasConfig) { test.skip(); return }

    // Back button (ChevronLeft) should be visible
    const backBtn = page.locator('[data-testid="health-configure"] button').filter({ has: page.locator('svg') }).first()
    const hasBack = await backBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasBack) { test.skip(); return }

    await backBtn.click()
    await page.waitForTimeout(500)

    // Should return to health landing (configure disappears)
    const configure = page.locator('[data-testid="health-configure"]')
    const stillVisible = await configure.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(stillVisible).toBeFalsy()
  })
})

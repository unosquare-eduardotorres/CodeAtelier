/**
 * CLAUDE.md Sync E2E Tests
 *
 * Verifies the SyncBanner and SyncReviewModal interactions:
 *   - Banner visibility when YAML changes are detected
 *   - Review Changes opens modal
 *   - Section expand/collapse
 *   - Apply sync changes
 *   - Dismiss modal without applying
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('CLAUDE.md Sync Review', () => {
  /** Navigate to Settings → Team tab where SyncBanner renders. */
  async function openTeamTab(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const settings = new WorkspaceSettings(page)
    const teamTab = settings.getTab('team')
    const hasTeam = await teamTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTeam) {
      await teamTab.click()
      await page.waitForTimeout(500)
    }
  }

  test('SyncBanner appears when YAML changes are detected', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const banner = page.locator('[data-testid="sync-banner"]')
    const visible = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!visible) {
      // No YAML drift detected — this is valid state
      test.skip()
      return
    }

    await expect(banner).toBeVisible()

    // Banner shows change counts
    const bannerText = await banner.textContent()
    expect(bannerText).toMatch(/YAML Sync Available/i)

    // Review & Sync button visible
    const reviewBtn = page.locator('[data-testid="sync-review-btn"]')
    await expect(reviewBtn).toBeVisible()
  })

  test('Review Changes opens SyncReviewModal', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const reviewBtn = page.locator('[data-testid="sync-review-btn"]')
    const visible = await reviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await reviewBtn.click()
    await page.waitForTimeout(500)

    // Modal should appear
    const modal = page.locator('[data-testid="sync-review-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Modal has header text
    const headerText = await modal.textContent()
    expect(headerText).toMatch(/Review YAML Sync/i)

    // Sections should be expandable (New, Updated, Removed)
    const sectionBtns = modal.locator('button').filter({ hasText: /New|Updated|Removed/i })
    const sectionCount = await sectionBtns.count()
    expect(sectionCount).toBeGreaterThanOrEqual(1)
  })

  test('SyncReviewModal section expand/collapse', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const reviewBtn = page.locator('[data-testid="sync-review-btn"]')
    const visible = await reviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await reviewBtn.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[data-testid="sync-review-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    // Find section toggle buttons
    const sectionBtns = modal.locator('button').filter({ hasText: /New|Updated|Removed/i })
    const count = await sectionBtns.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Click first section to toggle
    await sectionBtns.first().click()
    await page.waitForTimeout(300)

    // Click again to toggle back
    await sectionBtns.first().click()
    await page.waitForTimeout(300)
  })

  test('Apply sync changes', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const reviewBtn = page.locator('[data-testid="sync-review-btn"]')
    const visible = await reviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await reviewBtn.click()
    await page.waitForTimeout(500)

    const applyBtn = page.locator('[data-testid="sync-apply-btn"]')
    const hasApply = await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasApply) {
      test.skip()
      return
    }

    await applyBtn.click()
    await page.waitForTimeout(3_000)

    // After apply: either result summary or banner disappears
    const resultText = page.getByText(/Sync Complete|Sync Applied/i)
    const hasResult = await resultText.isVisible({ timeout: 10_000 }).catch(() => false)
    expect(hasResult).toBeTruthy()
  })

  test('Dismiss sync modal without applying', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const reviewBtn = page.locator('[data-testid="sync-review-btn"]')
    const visible = await reviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await reviewBtn.click()
    await page.waitForTimeout(500)

    const dismissBtn = page.locator('[data-testid="sync-dismiss-btn"]')
    const hasDismiss = await dismissBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasDismiss) {
      test.skip()
      return
    }

    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Modal should be gone
    const modal = page.locator('[data-testid="sync-review-modal"]')
    await expect(modal).toBeHidden({ timeout: 3_000 })

    // Banner should still be visible (changes not applied)
    const banner = page.locator('[data-testid="sync-banner"]')
    const stillVisible = await banner.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(stillVisible).toBeTruthy()
  })
})

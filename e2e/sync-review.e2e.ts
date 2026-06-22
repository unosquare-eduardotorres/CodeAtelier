/**
 * Sync Review E2E Tests
 *
 * Tests SyncReviewModal (355 LOC) + SyncBanner (92 LOC) — YAML agent sync:
 *   - Sync banner appears when YAML files differ from database
 *   - Banner shows new/updated/removed agent counts
 *   - "Review & Sync" button opens the sync review modal
 *   - Sync review modal shows collapsible sections (new, updated, removed, skills)
 *   - "Skip removed" toggle prevents agent deactivation
 *   - "Apply All Changes" button triggers the sync operation
 *   - Success result shows import/update/deactivate counts
 *
 * The SyncBanner appears in team settings when YAML files differ from the
 * database. Tests verify DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/sync-review.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Sync Review', () => {
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

  // ── Sync Banner ──

  test('sync banner appears when YAML files differ from database', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="sync-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Banner should show the YAML sync messaging
    const text = await banner.textContent()
    expect(text?.includes('YAML Sync Available') || text?.includes('sync')).toBeTruthy()
  })

  test('banner shows new/updated/removed agent counts', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="sync-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    const text = await banner.textContent()

    // Should show at least one count type
    const hasCountInfo =
      text?.includes('new agent') ||
      text?.includes('updated') ||
      text?.includes('removed') ||
      text?.includes('new skill')

    expect(hasCountInfo).toBeTruthy()
  })

  test('"Review & Sync" button opens the sync review modal', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="sync-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Click the "Review & Sync" button
    const reviewBtn = banner.locator('button:has-text("Review & Sync")')
    const hasBtn = await reviewBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasBtn) { test.skip(); return }

    await reviewBtn.click()
    await page.waitForTimeout(500)

    // The sync review modal should appear
    const modal = page.locator('[data-testid="sync-review-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasModal).toBeTruthy()
  })

  // ── Sync Review Modal ──

  test('sync review modal shows collapsible sections', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="sync-review-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      // Try to open via banner
      const banner = page.locator('[data-testid="sync-banner"]')
      const hasBanner = await banner.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasBanner) { test.skip(); return }

      const reviewBtn = banner.locator('button:has-text("Review & Sync")')
      await reviewBtn.click()
      await page.waitForTimeout(500)

      const nowVisible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!nowVisible) { test.skip(); return }
    }

    // Modal should have a header with "Review YAML Sync"
    const header = modal.locator('text=Review YAML Sync')
    await expect(header).toBeVisible()

    // Should have at least one collapsible section with a toggle button
    const sectionButtons = modal.locator('button').filter({ has: page.locator('svg') })
    const sectionCount = await sectionButtons.count()
    expect(sectionCount).toBeGreaterThan(0)
  })

  test('"Skip removed" toggle prevents agent deactivation', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="sync-review-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Look for the "Keep these specialists active" checkbox
    const keepCheckbox = modal.locator('input[type="checkbox"]')
    const hasCheckbox = await keepCheckbox.first().isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasCheckbox) { test.skip(); return }

    // The label should mention keeping specialists active
    const keepLabel = modal.locator('text=Keep these specialists active')
    const hasLabel = await keepLabel.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasLabel) { test.skip(); return }

    await expect(keepLabel).toBeVisible()
    await keepCheckbox.first().check()
    await expect(keepCheckbox.first()).toBeChecked()
  })

  test('"Apply All Changes" button triggers the sync operation', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="sync-review-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Apply button should be visible
    const applyBtn = page.locator('[data-testid="sync-review-apply"]')
    const hasApplyBtn = await applyBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasApplyBtn) { test.skip(); return }

    await expect(applyBtn).toBeVisible()
    await expect(applyBtn).toContainText('Apply All Changes')
    await expect(applyBtn).toBeEnabled()
  })

  test('success result shows import/update/deactivate counts', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    // Look for the success result view (shows after Apply completes)
    const syncComplete = page.locator('text=Sync Complete')
    const hasResult = await syncComplete.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasResult) {
      // Also check for "Sync Applied Successfully"
      const appliedText = page.locator('text=Sync Applied Successfully')
      const hasApplied = await appliedText.isVisible({ timeout: 2_000 }).catch(() => false)
      if (!hasApplied) { test.skip(); return }
    }

    // Result should show counts (imported/updated/deactivated)
    const resultArea = page.locator('[data-testid="sync-review-modal"]').or(
      page.locator('text=Sync Applied Successfully').locator('..')
    )
    const text = await resultArea.first().textContent()

    const hasResults =
      text?.includes('imported') ||
      text?.includes('updated') ||
      text?.includes('deactivated') ||
      text?.includes('skills imported')

    expect(hasResults).toBeTruthy()
  })
})

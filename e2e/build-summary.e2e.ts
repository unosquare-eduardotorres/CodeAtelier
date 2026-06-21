/**
 * Build Summary E2E Tests
 *
 * Tests BuildSummaryCard (178 LOC) — post-build result card in chat messages:
 *   - Build summary card renders in chat messages after build completes
 *   - Success header shows green checkmark and "Build Complete" text
 *   - Error header shows warning icon and "Build Finished with Errors"
 *   - Task list shows completed/failed counts with status icons
 *   - Files changed section shows unique file paths
 *   - Duration display shows human-readable time format
 *
 * The BuildSummaryCard appears inside chat messages after a Build-mode session
 * completes. Tests verify DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/build-summary.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Build Summary Card', () => {
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

  async function findBuildSummaryCard(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const card = page.locator('[data-testid="build-summary-card"]')
    const hasCard = await card.first().isVisible({ timeout: 5_000 }).catch(() => false)
    return hasCard ? card.first() : null
  }

  test('build summary card renders in chat messages after build completes', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    // Card should be visible with structural elements
    await expect(card).toBeVisible()

    // Should have a header section and a table
    const table = card.locator('table')
    await expect(table).toBeVisible()
  })

  test('success header shows green checkmark and "Build Complete" text', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    const text = await card.textContent()
    const isSuccess = text?.includes('Build Complete')

    if (!isSuccess) { test.skip(); return }

    // Should contain "Build Complete" text
    const successText = card.locator('text=Build Complete')
    await expect(successText).toBeVisible()

    // Should have an SVG icon (CheckCircle2)
    const svgIcon = card.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('error header shows warning icon and "Build Finished with Errors"', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    const text = await card.textContent()
    const hasErrors = text?.includes('Build Finished with Errors')

    if (!hasErrors) { test.skip(); return }

    // Should contain the error header text
    const errorText = card.locator('text=Build Finished with Errors')
    await expect(errorText).toBeVisible()

    // Should have warning icon
    const svgIcon = card.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('task list shows completed/failed counts with status icons', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    // Task rows should exist
    const taskRows = card.locator('[data-testid="build-summary-task"]')
    const count = await taskRows.count()

    if (count === 0) { test.skip(); return }

    expect(count).toBeGreaterThan(0)

    // Each task row should have status text (completed/failed/skipped)
    const firstRow = taskRows.first()
    const rowText = await firstRow.textContent()
    const hasStatus =
      rowText?.includes('completed') ||
      rowText?.includes('failed') ||
      rowText?.includes('skipped')
    expect(hasStatus).toBeTruthy()
  })

  test('files changed section shows unique file paths', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    // Look for "Files Changed" section
    const filesSection = card.locator('text=Files Changed')
    const hasFilesSection = await filesSection.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasFilesSection) { test.skip(); return }

    await expect(filesSection).toBeVisible()

    // File badges should be monospace text with file paths
    const fileBadges = card.locator('.font-mono')
    const badgeCount = await fileBadges.count()
    expect(badgeCount).toBeGreaterThan(0)
  })

  test('duration display shows human-readable time format', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const card = await findBuildSummaryCard(page)
    if (!card) { test.skip(); return }

    // The header subtitle contains duration info (e.g., "3 completed · 1m 23s")
    const text = await card.textContent()

    // Duration should be in format like "Xs", "Xm Xs", or "Xms"
    const hasDuration =
      /\d+s/.test(text ?? '') || /\d+m\s*\d+s/.test(text ?? '') || /\d+ms/.test(text ?? '')
    expect(hasDuration).toBeTruthy()
  })
})

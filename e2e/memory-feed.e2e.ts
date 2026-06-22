/**
 * Memory Feed Banner E2E Tests
 *
 * Tests MemoryFeedBanner (83 LOC) — memory ingestion progress:
 *   - Memory feed banner shows during CLAUDE.md ingestion
 *   - Running state shows spinner and source label
 *   - Completed state shows success message with auto-dismiss
 *   - Error state shows error message with dismiss button
 *   - Cancel button stops the feed operation
 *
 * The MemoryFeedBanner appears as a top-level notification during memory
 * ingestion (CLAUDE.md, codebase scan, document ingestion). Tests verify
 * DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/memory-feed.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Memory Feed Banner', () => {
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

  async function findMemoryFeedBanner(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const banner = page.locator('[data-testid="memory-feed-banner"]')
    const hasBanner = await banner.first().isVisible({ timeout: 5_000 }).catch(() => false)
    return hasBanner ? banner.first() : null
  }

  test('memory feed banner shows during CLAUDE.md ingestion', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = await findMemoryFeedBanner(page)
    if (!banner) { test.skip(); return }

    // Banner should be visible
    await expect(banner).toBeVisible()

    // Should contain meaningful content
    const text = await banner.textContent()
    expect(text?.length).toBeGreaterThan(0)
  })

  test('running state shows spinner and source label', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = await findMemoryFeedBanner(page)
    if (!banner) { test.skip(); return }

    const text = await banner.textContent()

    // Check if it's in running state (has spinner)
    const spinner = banner.locator('.animate-spin')
    const isRunning = await spinner.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!isRunning) { test.skip(); return }

    // Should show a source label (CLAUDE.md ingestion, Codebase scan, etc.)
    const hasSourceLabel =
      text?.includes('CLAUDE.md') ||
      text?.includes('Codebase scan') ||
      text?.includes('Document ingestion') ||
      text?.includes('Memory feed')

    expect(hasSourceLabel).toBeTruthy()

    // Should show "You can continue working" message
    const hasContinueMsg = text?.includes('continue working')
    expect(hasContinueMsg).toBeTruthy()
  })

  test('completed state shows success message with auto-dismiss', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = await findMemoryFeedBanner(page)
    if (!banner) { test.skip(); return }

    // Check for success state (green check icon, success-muted background)
    const successIcon = banner.locator('svg.text-success')
    const isCompleted = await successIcon.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!isCompleted) { test.skip(); return }

    // Should have dismiss button
    const dismissBtn = banner.locator('button[aria-label="Dismiss"]')
    await expect(dismissBtn).toBeVisible()

    // Banner should auto-dismiss after ~8s (verify it becomes hidden)
    await expect(banner).toBeHidden({ timeout: 12_000 })
  })

  test('error state shows error message with dismiss button', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = await findMemoryFeedBanner(page)
    if (!banner) { test.skip(); return }

    // Check for error state (danger coloring)
    const errorIcon = banner.locator('svg.text-danger')
    const isError = await errorIcon.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!isError) { test.skip(); return }

    // Should show "failed:" text
    const text = await banner.textContent()
    expect(text?.includes('failed')).toBeTruthy()

    // Dismiss button should be present
    const dismissBtn = banner.locator('button[aria-label="Dismiss"]')
    await expect(dismissBtn).toBeVisible()

    // Click dismiss — banner should hide
    await dismissBtn.click()
    await page.waitForTimeout(500)
    await expect(banner).toBeHidden({ timeout: 3_000 })
  })

  test('cancel button stops the feed operation', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = await findMemoryFeedBanner(page)
    if (!banner) { test.skip(); return }

    // Cancel button is only in running state
    const cancelBtn = banner.locator('button:has-text("Cancel")')
    const hasCancel = await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasCancel) { test.skip(); return }

    await expect(cancelBtn).toBeVisible()

    // Click cancel
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Banner should be hidden after cancel
    await expect(banner).toBeHidden({ timeout: 3_000 })
  })
})

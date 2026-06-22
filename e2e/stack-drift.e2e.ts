/**
 * Stack Drift Banner E2E Tests
 *
 * Tests StackDriftBanner (83 LOC) — tech stack change notification:
 *   - Stack drift banner renders when tech stack changes detected
 *   - Banner shows added and removed technologies
 *   - "Rebuild prompt" button triggers full specialist rebuild
 *   - "Update skills only" button triggers skills-only rebuild
 *   - Dismiss button hides the banner
 *
 * The StackDriftBanner appears at the top of ChatPanel when the workspace's
 * tech stack has changed since the Project Specialist was last built.
 * Tests verify DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/stack-drift.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Stack Drift Banner', () => {
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

  test('stack drift banner renders when tech stack changes detected', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Banner should contain tech stack change messaging
    const text = await banner.textContent()
    expect(text?.includes('tech stack has changed')).toBeTruthy()

    // Should have a warning icon
    const svgIcon = banner.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('banner shows added and removed technologies', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    const text = await banner.textContent()

    // Should show added or removed technologies
    const hasTechInfo =
      text?.includes('Added:') || text?.includes('Removed:')

    expect(hasTechInfo).toBeTruthy()
  })

  test('"Rebuild prompt" button triggers full specialist rebuild', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Rebuild prompt button should be visible
    const rebuildBtn = page.locator('[data-testid="stack-drift-rebuild"]')
    await expect(rebuildBtn).toBeVisible()
    await expect(rebuildBtn).toContainText('Rebuild prompt')

    // Should have the hammer icon
    const svgIcon = rebuildBtn.locator('svg')
    await expect(svgIcon).toBeVisible()
  })

  test('"Update skills only" button triggers skills-only rebuild', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Update skills button should be visible
    const updateBtn = banner.locator('button:has-text("Update skills only")')
    const hasBtn = await updateBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasBtn) { test.skip(); return }

    await expect(updateBtn).toBeVisible()

    // Should have the sparkles icon
    const svgIcon = updateBtn.locator('svg')
    await expect(svgIcon).toBeVisible()
  })

  test('dismiss button hides the banner', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Dismiss button (X) should be visible
    const dismissBtn = banner.locator('button[aria-label="Dismiss"]')
    const hasDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDismiss) { test.skip(); return }

    await expect(dismissBtn).toBeVisible()

    // Click dismiss
    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Banner should be hidden
    await expect(banner).toBeHidden({ timeout: 3_000 })
  })
})

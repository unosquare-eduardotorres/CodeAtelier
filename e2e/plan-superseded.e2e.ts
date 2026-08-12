/**
 * Plan Superseded E2E Tests
 *
 * Tests that when a conversation has multiple plan messages, all plans
 * render as slim indicators. The latest plan has no "superseded" label,
 * while older plans show a "superseded" badge.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/plan-superseded.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Plan Superseded Indicators', () => {
  async function ensureChatReady(page: import('@playwright/test').Page): Promise<boolean> {
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
    const chatsTab = page.locator('[data-testid="sidebar-chats-tab"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return true
  }

  test('plan slim indicator renders for plan messages', async ({ electronPage: page }) => {
    const ready = await ensureChatReady(page)
    if (!ready) {
      test.skip()
      return
    }

    // Look for plan slim indicators
    const slimIndicators = page.locator('[data-testid="plan-slim-indicator"]')
    const count = await slimIndicators.count().catch(() => 0)

    if (count === 0) {
      // No plan messages in current conversation
      test.skip()
      return
    }

    // All plan messages should render as slim indicators
    const firstIndicator = slimIndicators.first()
    await expect(firstIndicator).toBeVisible({ timeout: 5_000 })

    // Should contain the "Plan available" text
    const text = await firstIndicator.textContent()
    expect(text).toContain('Plan available')
  })

  test('superseded label appears on older plan messages', async ({ electronPage: page }) => {
    const ready = await ensureChatReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const supersededLabels = page.locator('[data-testid="plan-superseded-label"]')
    const count = await supersededLabels.count().catch(() => 0)

    if (count === 0) {
      // No superseded plans — either only one plan or no plans
      test.skip()
      return
    }

    const firstLabel = supersededLabels.first()
    await expect(firstLabel).toBeVisible({ timeout: 5_000 })

    // Should contain the "superseded" text
    const text = await firstLabel.textContent()
    expect(text!.toLowerCase()).toContain('superseded')
  })

  test('latest plan indicator does not show superseded label', async ({ electronPage: page }) => {
    const ready = await ensureChatReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const slimIndicators = page.locator('[data-testid="plan-slim-indicator"]')
    const count = await slimIndicators.count().catch(() => 0)

    if (count === 0) {
      test.skip()
      return
    }

    // The last slim indicator is the latest plan — it should NOT have a superseded label
    const lastIndicator = slimIndicators.last()
    const supersededInLast = lastIndicator.locator('[data-testid="plan-superseded-label"]')
    const hasSuperseded = await supersededInLast.count()
    expect(hasSuperseded).toBe(0)
  })
})

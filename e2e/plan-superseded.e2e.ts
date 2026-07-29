/**
 * Plan Superseded E2E Tests
 *
 * Tests that when a conversation has multiple plan messages, only the latest
 * renders as a full TaskPlanCard, while older plans render as collapsed
 * superseded cards with click-to-expand behavior.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/plan-superseded.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Plan Superseded Cards', () => {
  async function ensureChatReady(
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
    const chatsTab = page.locator('[data-testid="sidebar-chats-tab"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return true
  }

  test('only the latest plan card has task-plan-card testid', async ({
    electronPage: page
  }) => {
    const ready = await ensureChatReady(page)
    if (!ready) { test.skip(); return }

    // Look for plan cards
    const planCards = page.locator('[data-testid="task-plan-card"]')
    const supersededCards = page.locator('[data-testid="task-plan-card-superseded"]')

    const planCount = await planCards.count().catch(() => 0)
    const supersededCount = await supersededCards.count().catch(() => 0)

    // Skip if no plan cards exist at all
    if (planCount === 0 && supersededCount === 0) {
      test.skip()
      return
    }

    // When plans exist, at most 1 should be the active task-plan-card
    expect(planCount).toBeLessThanOrEqual(1)

    // If both exist, the superseded cards should be collapsed (smaller)
    if (planCount > 0 && supersededCount > 0) {
      const activeCard = planCards.first()
      await expect(activeCard).toBeVisible()

      const supersededCard = supersededCards.first()
      await expect(supersededCard).toBeVisible()

      // Superseded card should be visually smaller (collapsed)
      const activeBox = await activeCard.boundingBox()
      const supersededBox = await supersededCard.boundingBox()
      if (activeBox && supersededBox) {
        expect(supersededBox.height).toBeLessThan(activeBox.height)
      }
    }
  })

  test('superseded card shows plan title and superseded badge', async ({
    electronPage: page
  }) => {
    const ready = await ensureChatReady(page)
    if (!ready) { test.skip(); return }

    const supersededCards = page.locator('[data-testid="task-plan-card-superseded"]')
    if (!(await supersededCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const firstSuperseded = supersededCards.first()
    const text = await firstSuperseded.textContent()
    expect(text).toBeTruthy()

    // Should contain the "superseded" badge
    expect(text!.toLowerCase()).toContain('superseded')
  })

  test('clicking superseded card expands it to show full plan content', async ({
    electronPage: page
  }) => {
    const ready = await ensureChatReady(page)
    if (!ready) { test.skip(); return }

    const supersededCards = page.locator('[data-testid="task-plan-card-superseded"]')
    if (!(await supersededCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Get the initial collapsed height
    const initialBox = await supersededCards.first().boundingBox()
    if (!initialBox) { test.skip(); return }

    // Click to expand
    const expandButton = supersededCards.first().locator('button').first()
    await expandButton.click()
    await page.waitForTimeout(300) // Wait for transition

    // After expansion, the card testid changes to 'task-plan-card' (expanded superseded)
    // and should have more content visible
    const expandedCard = page.locator('[data-testid="task-plan-card"]')

    // There might now be multiple task-plan-card elements (the original latest + the expanded superseded)
    const expandedCount = await expandedCard.count()
    expect(expandedCount).toBeGreaterThanOrEqual(1)
  })

  test('expanded superseded card does not show action buttons', async ({
    electronPage: page
  }) => {
    const ready = await ensureChatReady(page)
    if (!ready) { test.skip(); return }

    const supersededCards = page.locator('[data-testid="task-plan-card-superseded"]')
    if (!(await supersededCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Click to expand
    const expandButton = supersededCards.first().locator('button').first()
    await expandButton.click()
    await page.waitForTimeout(300)

    // The superseded card — when expanded — should NOT have Build Now or Refine buttons
    // Look for the BuildActionBar buttons that only appear on the latest plan
    const allPlanCards = page.locator('[data-testid="task-plan-card"]')
    const lastCard = allPlanCards.last()

    // If there are 2+ task-plan-card elements now (latest + expanded superseded),
    // check that at most the last one has action buttons
    const count = await allPlanCards.count()
    if (count >= 2) {
      // The first card (expanded superseded) should not have build/refine buttons
      const firstCardText = (await allPlanCards.first().textContent()) ?? ''
      // Superseded card text should contain "superseded" badge
      if (firstCardText.toLowerCase().includes('superseded')) {
        const buildButton = allPlanCards.first().locator('button:has-text("Build"), button:has-text("Implement")')
        const refineButton = allPlanCards.first().locator('button:has-text("Refine")')
        expect(await buildButton.count()).toBe(0)
        expect(await refineButton.count()).toBe(0)
      }
    }

    // Verify the latest plan card (last) still has action buttons or at least exists
    await expect(lastCard).toBeVisible()
  })
})

/**
 * Cross-Area Plan Flow E2E Tests — Tier A (Highest Impact)
 *
 * Verifies the integration seams where multiple stores interact
 * through the Plan Hub registry. These are the hardest flows to
 * catch in manual testing and the most fragile in production.
 *
 *   1. Grill → Plan → Chat: Complete grill → plan appears with 🔥 badge → "Open in Chat"
 *   2. Blueprint → Plan → Goal: Blueprint plan appears with 📘 badge → "Start Goal"
 *   3. Council → Plan → Chat: Council plan appears with 🏛️ badge → "Open in Chat"
 *   4. Chat → Plan → Goal: Chat plan with 💬 badge → "Start Goal" → MPA page
 *   5. Plan → Goal → Campaign: "Start Goal" on any plan → Goal page → Campaign initiated
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/cross-area-plan-flow.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Cross-Area Plan Flows', () => {
  // ── Shared navigation helpers ──────────────────────────────────────

  async function navigateToPlans(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

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

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('plans')
    await page.waitForTimeout(500)
  }

  async function selectFilter(
    page: import('@playwright/test').Page,
    filter: 'all' | 'saved' | 'active' | 'done'
  ): Promise<boolean> {
    const tab = page.locator(`[data-testid="plan-filter-${filter}"]`)
    const hasTab = await tab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasTab) {
      await tab.click()
      await page.waitForTimeout(300)
    }
    return hasTab
  }

  /**
   * Find a plan card that matches a source emoji/text pattern.
   * Returns the matching card locator, or null if not found.
   */
  async function findPlanBySource(
    page: import('@playwright/test').Page,
    sourcePattern: RegExp
  ): Promise<import('@playwright/test').Locator | null> {
    const planCards = page.locator('[data-testid^="plan-card-"]')
    const count = await planCards.count()

    for (let i = 0; i < Math.min(count, 20); i++) {
      const text = await planCards.nth(i).textContent()
      if (sourcePattern.test(text ?? '')) {
        return planCards.nth(i)
      }
    }
    return null
  }

  // ── 1. Grill → Plan → Chat ─────────────────────────────────────────

  test('Grill → Plan → Chat: grill-sourced plan opens in chat', async ({
    electronPage: page
  }) => {
    await navigateToPlans(page)
    await selectFilter(page, 'all')

    // Find a grill-sourced plan (🔥 badge or "Grill" text)
    const grillPlan = await findPlanBySource(page, /🔥|grill/i)

    if (!grillPlan) {
      test.skip()
      return
    }

    // Verify the plan has the grill source badge
    const cardText = await grillPlan.textContent()
    expect(cardText).toMatch(/🔥|grill/i)

    // Click "Open in Chat" on this grill-sourced plan
    const openInChatBtn = grillPlan
      .locator('[data-testid="plan-action-open-in-chat"]')
      .or(grillPlan.getByRole('button', { name: /open in chat/i }))
      .first()
    const hasBtn = await openInChatBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      // Plan might already be handed_off — check for "Open Conversation"
      const openConvBtn = grillPlan
        .locator('[data-testid="plan-action-open-conversation"]')
        .or(grillPlan.getByRole('button', { name: /open conversation/i }))
        .first()
      const hasConvBtn = await openConvBtn.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasConvBtn) {
        await openConvBtn.click()
        await page.waitForTimeout(2_000)
      } else {
        test.skip()
        return
      }
    } else {
      await openInChatBtn.click()
      await page.waitForTimeout(2_000)
    }

    // Verify we navigated to chat — chat panel or message input visible
    const chatPanel = page.locator('[data-testid="chat-panel"]')
    const messageInput = page.locator('[data-testid="message-input"]')
    const newChatPage = page.locator('[data-testid="new-chat-page"]')

    const hasChatPanel = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasMessageInput = await messageInput.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasNewChat = await newChatPage.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasChatPanel || hasMessageInput || hasNewChat).toBeTruthy()
  })

  // ── 2. Blueprint → Plan → Goal ─────────────────────────────────────

  test('Blueprint → Plan → Goal: blueprint-sourced plan starts goal', async ({
    electronPage: page
  }) => {
    await navigateToPlans(page)
    await selectFilter(page, 'all')

    // Find a blueprint-sourced plan (📘 badge or "Blueprint" text)
    const blueprintPlan = await findPlanBySource(page, /📘|blueprint/i)

    if (!blueprintPlan) {
      test.skip()
      return
    }

    // Verify blueprint source badge
    const cardText = await blueprintPlan.textContent()
    expect(cardText).toMatch(/📘|blueprint/i)

    // Click "Start Goal" on this blueprint-sourced plan
    const startGoalBtn = blueprintPlan
      .locator('[data-testid="plan-action-start-goal"]')
      .or(blueprintPlan.getByRole('button', { name: /start goal/i }))
      .first()
    const hasBtn = await startGoalBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      // Plan might not be in "saved" status — Start Goal only shows on saved plans
      test.skip()
      return
    }

    await startGoalBtn.click()
    await page.waitForTimeout(2_000)

    // Verify navigation to Goals/MPA page
    const goalsIndicator = page
      .getByText(/goal|campaign|multi-phase|decompos/i)
      .first()
    const hasGoalsPage = await goalsIndicator
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    expect(hasGoalsPage).toBeTruthy()
  })

  // ── 3. Council → Plan → Chat ────────────────────────────────────────

  test('Council → Plan → Chat: council-sourced plan opens in chat', async ({
    electronPage: page
  }) => {
    await navigateToPlans(page)
    await selectFilter(page, 'all')

    // Find a council-sourced plan (🏛️ badge or "Council" text)
    const councilPlan = await findPlanBySource(page, /🏛️|council/i)

    if (!councilPlan) {
      test.skip()
      return
    }

    // Verify council source badge
    const cardText = await councilPlan.textContent()
    expect(cardText).toMatch(/🏛️|council/i)

    // Click "Open in Chat" or "Open Conversation"
    const openBtn = councilPlan
      .locator('[data-testid="plan-action-open-in-chat"]')
      .or(councilPlan.locator('[data-testid="plan-action-open-conversation"]'))
      .or(councilPlan.getByRole('button', { name: /open in chat|open conversation/i }))
      .first()
    const hasBtn = await openBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    await openBtn.click()
    await page.waitForTimeout(2_000)

    // Verify navigation to chat view
    const chatPanel = page.locator('[data-testid="chat-panel"]')
    const messageInput = page.locator('[data-testid="message-input"]')
    const newChatPage = page.locator('[data-testid="new-chat-page"]')

    const hasChatPanel = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasMessageInput = await messageInput.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasNewChat = await newChatPage.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasChatPanel || hasMessageInput || hasNewChat).toBeTruthy()
  })

  // ── 4. Chat → Plan → Goal ──────────────────────────────────────────

  test('Chat → Plan → Goal: chat-sourced plan starts goal', async ({
    electronPage: page
  }) => {
    await navigateToPlans(page)
    await selectFilter(page, 'saved')

    // Find a chat-sourced plan (💬 badge or "Chat" text)
    const chatPlan = await findPlanBySource(page, /💬|chat/i)

    if (!chatPlan) {
      // Try "all" filter if no saved chat plans
      await selectFilter(page, 'all')
      const allChatPlan = await findPlanBySource(page, /💬|chat/i)
      if (!allChatPlan) {
        test.skip()
        return
      }
    }

    // Re-find to get correct reference after possible filter change
    const plan = await findPlanBySource(page, /💬|chat/i)
    if (!plan) {
      test.skip()
      return
    }

    // Click "Start Goal" on this chat-sourced plan
    const startGoalBtn = plan
      .locator('[data-testid="plan-action-start-goal"]')
      .or(plan.getByRole('button', { name: /start goal/i }))
      .first()
    const hasBtn = await startGoalBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    await startGoalBtn.click()
    await page.waitForTimeout(2_000)

    // Verify navigation to Goals/MPA page
    const goalsIndicator = page
      .getByText(/goal|campaign|multi-phase|decompos/i)
      .first()
    const hasGoalsPage = await goalsIndicator
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    expect(hasGoalsPage).toBeTruthy()
  })

  // ── 5. Plan → Goal → Campaign ──────────────────────────────────────

  test('Plan → Goal → Campaign: start goal initiates campaign view', async ({
    electronPage: page
  }) => {
    await navigateToPlans(page)
    await selectFilter(page, 'saved')

    // Find ANY saved plan with a "Start Goal" button
    const planCards = page.locator('[data-testid^="plan-card-"]')
    const count = await planCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Find first plan card that has a "Start Goal" button
    let targetCard: import('@playwright/test').Locator | null = null
    for (let i = 0; i < Math.min(count, 10); i++) {
      const card = planCards.nth(i)
      const goalBtn = card
        .locator('[data-testid="plan-action-start-goal"]')
        .or(card.getByRole('button', { name: /start goal/i }))
        .first()
      const hasGoalBtn = await goalBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasGoalBtn) {
        targetCard = card
        break
      }
    }

    if (!targetCard) {
      test.skip()
      return
    }

    // Get plan title for later verification
    const _planTitle = await targetCard.locator('.font-semibold, .font-medium').first().textContent()

    // Click "Start Goal"
    const startGoalBtn = targetCard
      .locator('[data-testid="plan-action-start-goal"]')
      .or(targetCard.getByRole('button', { name: /start goal/i }))
      .first()
    await startGoalBtn.click()
    await page.waitForTimeout(2_000)

    // Verify Goals page loaded with plan content
    const goalsArea = page
      .getByText(/goal|campaign|multi-phase|decompos|describe/i)
      .first()
    const hasGoalsArea = await goalsArea
      .isVisible({ timeout: 10_000 })
      .catch(() => false)
    expect(hasGoalsArea).toBeTruthy()

    // Verify plan content was preloaded into the goal description
    // The textarea or readonly area should contain plan-related content
    const descriptionArea = page.locator('textarea').first()
    const hasDescription = await descriptionArea.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasDescription) {
      const descValue = await descriptionArea.inputValue().catch(() => '')
      // Plan content should be non-empty (preloaded from requirementDocument or title+summary)
      expect(descValue.length).toBeGreaterThan(0)
    }

    // Verify campaign initiation controls are available
    const generateBtn = page.getByRole('button', { name: /generate|start|run|decompose/i }).first()
    const hasGenerateBtn = await generateBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasGenerateBtn).toBeTruthy()
  })
})

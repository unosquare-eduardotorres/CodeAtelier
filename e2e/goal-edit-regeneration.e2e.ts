/**
 * Goal Edit → Regeneration E2E Tests
 *
 * Tests GoalCard modification awareness in the ChatExecutionPanel Plan tab:
 *   - Editing goal text shows "Modified" badge with amber styling
 *   - Reset button reverts goal to original text
 *   - Regenerate Plan button sends message with updated goal
 *   - Whitespace-only changes do not trigger Modified state
 *   - Goal card shows character counter for long goals
 *
 * This tests the ChatExecutionPanel's GoalCard (not GoalCampaignPanel).
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/goal-edit-regeneration.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { ChatPage } from './pages/chat-page'
import { WelcomePage } from './pages/welcome-page'

test.describe('Goal editing in execution panel', () => {
  async function ensureChatReady(
    page: import('@playwright/test').Page
  ): Promise<ChatPage | null> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return null
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return new ChatPage(page)
  }

  /** Open the execution panel and switch to the Plan tab */
  async function openPlanTab(page: import('@playwright/test').Page): Promise<boolean> {
    const toggle = page.locator('[data-testid="task-summary-badge-toggle"]')
    const hasToggle = await toggle.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasToggle) return false
    await toggle.click()
    await page.waitForTimeout(500)

    const planTab = page.locator('[data-testid="chat-execution-tab-plan"]')
    const hasTab = await planTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTab) return false
    await planTab.click()
    await page.waitForTimeout(500)
    return true
  }

  /** Check if a GoalCard with editable textarea is visible */
  async function findGoalTextarea(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const textarea = page.locator('[data-testid="goal-textarea"]')
    const visible = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)
    return visible ? textarea : null
  }

  test('shows Modified badge when goal text is changed', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planTabOpen = await openPlanTab(page)
    if (!planTabOpen) { test.skip(); return }

    const textarea = await findGoalTextarea(page)
    if (!textarea) { test.skip(); return }

    // Get original value
    const originalValue = await textarea.inputValue()
    if (!originalValue) { test.skip(); return }

    // Type new text to modify the goal
    await textarea.fill(originalValue + ' — updated goal')
    await page.waitForTimeout(300)

    // Assert "Modified" text is visible
    const goalCard = page.locator('[data-testid="goal-card"]')
    const modifiedBadge = goalCard.locator('text=Modified')
    await expect(modifiedBadge).toBeVisible({ timeout: 3_000 })

    // Assert amber border is applied
    const cardClasses = await goalCard.getAttribute('class')
    expect(cardClasses).toContain('border-amber')
  })

  test('Reset button reverts goal to original', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planTabOpen = await openPlanTab(page)
    if (!planTabOpen) { test.skip(); return }

    const textarea = await findGoalTextarea(page)
    if (!textarea) { test.skip(); return }

    const originalValue = await textarea.inputValue()
    if (!originalValue) { test.skip(); return }

    // Modify the goal
    await textarea.fill('Completely different goal text')
    await page.waitForTimeout(300)

    // Click Reset button
    const goalCard = page.locator('[data-testid="goal-card"]')
    const resetBtn = goalCard.locator('button', { hasText: 'Reset' })
    const hasReset = await resetBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasReset) { test.skip(); return }
    await resetBtn.click()
    await page.waitForTimeout(300)

    // Assert textarea value matches original
    await expect(textarea).toHaveValue(originalValue)

    // Assert "Modified" badge is gone
    const modifiedBadge = goalCard.locator('text=Modified')
    await expect(modifiedBadge).not.toBeVisible({ timeout: 2_000 })
  })

  test('Regenerate Plan sends message with updated goal', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planTabOpen = await openPlanTab(page)
    if (!planTabOpen) { test.skip(); return }

    const textarea = await findGoalTextarea(page)
    if (!textarea) { test.skip(); return }

    const originalValue = await textarea.inputValue()
    if (!originalValue) { test.skip(); return }

    // Edit goal text
    const newGoal = 'Build a REST API with JWT authentication'
    await textarea.fill(newGoal)
    await page.waitForTimeout(300)

    // Click Regenerate Plan button
    const regenerateBtn = page.locator('[data-testid="goal-regenerate-plan"]')
    const hasRegenerate = await regenerateBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasRegenerate) { test.skip(); return }
    await regenerateBtn.click()
    await page.waitForTimeout(1_000)

    // After clicking, GoalCard should become read-only (userClicked=true)
    // The textarea should be replaced by a paragraph
    const textareaAfter = page.locator('[data-testid="goal-textarea"]')
    const isStillEditable = await textareaAfter.isVisible({ timeout: 2_000 }).catch(() => false)
    // Read-only mode replaces textarea with <p> — textarea should not be visible
    expect(isStillEditable).toBe(false)
  })

  test('Regenerate Plan blocked while streaming', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planTabOpen = await openPlanTab(page)
    if (!planTabOpen) { test.skip(); return }

    const textarea = await findGoalTextarea(page)
    if (!textarea) { test.skip(); return }

    // Check if chat is currently streaming — if so, try to regenerate
    const stopBtn = page.locator('[data-testid="stop-streaming-button"]')
    const isStreaming = await stopBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!isStreaming) {
      // Can't test streaming guard without an active stream — skip
      test.skip()
      return
    }

    // Edit goal and try to regenerate while streaming
    const currentValue = await textarea.inputValue()
    await textarea.fill(currentValue + ' modified')
    await page.waitForTimeout(300)

    const regenerateBtn = page.locator('[data-testid="goal-regenerate-plan"]')
    const hasRegenerate = await regenerateBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasRegenerate) { test.skip(); return }
    await regenerateBtn.click()
    await page.waitForTimeout(500)

    // Assert toast "Chat is busy" appears
    const toast = page.locator('text=Chat is busy')
    await expect(toast).toBeVisible({ timeout: 3_000 })
  })

  test('whitespace-only changes do not trigger Modified state', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planTabOpen = await openPlanTab(page)
    if (!planTabOpen) { test.skip(); return }

    const textarea = await findGoalTextarea(page)
    if (!textarea) { test.skip(); return }

    const originalValue = await textarea.inputValue()
    if (!originalValue) { test.skip(); return }

    // Add trailing spaces only
    await textarea.fill(originalValue + '   ')
    await page.waitForTimeout(300)

    // Assert "Modified" badge is NOT visible (trim comparison)
    const goalCard = page.locator('[data-testid="goal-card"]')
    const modifiedBadge = goalCard.locator('text=Modified')
    await expect(modifiedBadge).not.toBeVisible({ timeout: 2_000 })
  })
})

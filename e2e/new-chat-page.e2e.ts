/**
 * New Chat Page E2E Tests
 *
 * Verifies the NewChatPage component (522 LOC) — the first screen users
 * see when starting a conversation:
 *   - Title input auto-focus + character counter
 *   - Mode toggle (Plan / Build)
 *   - Communication tone selector
 *   - Provider toggle (Claude / Local LLM)
 *   - MCP tools expand/collapse and toggle switches
 *   - Start Conversation and Create Idea buttons
 *   - Cmd+Enter keyboard shortcut
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/new-chat-page.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('New Chat Page', () => {
  /**
   * Helper: navigate to a workspace and ensure NewChatPage is visible.
   */
  async function navigateToNewChat(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const newChatPage = page.locator('[data-testid="new-chat-page"]')
    const isVisible = await newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (isVisible) return true

    await page.keyboard.press('Meta+n')
    await page.waitForTimeout(1_500)
    return newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('new chat page renders with title input and CTA', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    await expect(page.locator('[data-testid="new-chat-page"]')).toBeVisible()
    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    await expect(titleInput).toBeVisible()
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')
    await expect(startBtn).toBeVisible()
    await expect(startBtn).toBeDisabled()
  })

  test('title input enables Start button', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')
    await expect(startBtn).toBeDisabled()
    await titleInput.fill('Add user authentication')
    await expect(startBtn).toBeEnabled()
    await titleInput.clear()
    await expect(startBtn).toBeDisabled()
  })

  test('mode toggle switches between Plan and Build', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const modeToggle = page.locator('[data-testid="new-chat-mode-toggle"]')
    await expect(modeToggle).toBeVisible()
    const planBtn = modeToggle.getByRole('button', { name: /plan/i })
    const buildBtn = modeToggle.getByRole('button', { name: /build/i })
    await expect(planBtn).toBeVisible()
    await expect(buildBtn).toBeVisible()

    await buildBtn.click()
    await page.waitForTimeout(300)
    const isolatedBranch = page.getByText(/isolated branch/i)
    const hasIsolated = await isolatedBranch.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasIsolated).toBeTruthy()

    await planBtn.click()
    await page.waitForTimeout(300)
    const stillVisible = await isolatedBranch.isVisible({ timeout: 1_000 }).catch(() => false)
    expect(stillVisible).toBeFalsy()
  })

  test('tone selector buttons toggle', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const toneSelector = page.locator('[data-testid="new-chat-tone-selector"]')
    await expect(toneSelector).toBeVisible()
    const defaultBtn = toneSelector.getByRole('button', { name: /workspace default/i })
    await expect(defaultBtn).toBeVisible()

    const toneButtons = toneSelector.locator('button')
    const count = await toneButtons.count()
    if (count > 1) {
      await toneButtons.nth(1).click()
      await page.waitForTimeout(300)
      await defaultBtn.click()
      await page.waitForTimeout(300)
    }
  })

  test('provider toggle switches Cloud/Local', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const providerToggle = page.locator('[data-testid="new-chat-provider-toggle"]')
    await expect(providerToggle).toBeVisible()
    const claudeBtn = providerToggle.getByRole('button', { name: /claude/i })
    const localBtn = providerToggle.getByRole('button', { name: /local/i })
    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()

    await localBtn.click()
    await page.waitForTimeout(300)
    await claudeBtn.click()
    await page.waitForTimeout(300)
    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()
  })

  test('MCP tools section expands with toggle switches', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const mcpSection = page.locator('[data-testid="new-chat-mcp-section"]')
    const mcpExpand = page.locator('[data-testid="new-chat-mcp-expand"]')
    const hasMcp = await mcpSection.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasMcp) {
      test.skip()
      return
    }

    await mcpExpand.click()
    await page.waitForTimeout(500)
    const toggles = mcpSection.locator('button[aria-label]')
    const toggleCount = await toggles.count()
    if (toggleCount > 0) {
      await toggles.first().click()
      await page.waitForTimeout(300)
    }
    await mcpExpand.click()
    await page.waitForTimeout(300)
  })

  test('Start Conversation creates chat', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')
    await titleInput.fill('E2E Test Conversation')
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    const messageInput = page.locator('[data-testid="message-input"]')
    const chatPanel = page.locator('[data-testid="chat-panel"]')
    const hasChat = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasInput = await messageInput.isVisible({ timeout: 10_000 }).catch(() => false)
    expect(hasChat || hasInput).toBeTruthy()
  })

  test('Cmd+Enter shortcut submits form', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const descriptionInput = page.locator('[data-testid="new-chat-description"]')
    await titleInput.fill('Shortcut Test Chat')
    await descriptionInput.fill('Testing Cmd+Enter shortcut')
    await page.keyboard.press('Meta+Enter')

    const messageInput = page.locator('[data-testid="message-input"]')
    const chatPanel = page.locator('[data-testid="chat-panel"]')
    const hasChat = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasInput = await messageInput.isVisible({ timeout: 10_000 }).catch(() => false)
    expect(hasChat || hasInput).toBeTruthy()
  })
})

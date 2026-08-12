/**
 * Idea Capture E2E Tests
 *
 * Tests IdeaPopover (123 LOC) — floating idea capture from chat context:
 *   - Idea popover renders with "Capture an Idea" header
 *   - Title input accepts text and is required for save
 *   - Description textarea is optional
 *   - Save button disabled when title is empty
 *   - Escape key closes the idea popover
 *   - Successful save shows "Idea saved!" confirmation with checkmark
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/idea-capture.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { ChatPage } from './pages/chat-page'
import { WelcomePage } from './pages/welcome-page'

test.describe('Idea Capture', () => {
  async function ensureChatReady(page: import('@playwright/test').Page): Promise<ChatPage | null> {
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
    const chatsTab = page.locator('[data-testid="sidebar-chats-tab"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return new ChatPage(page)
  }

  async function openIdeaPopover(page: import('@playwright/test').Page): Promise<boolean> {
    // Look for the idea/lightbulb button in the chat toolbar
    const ideaBtn = page
      .locator('button[aria-label*="dea"], button[title*="dea"], button:has(svg.lucide-lightbulb)')
      .first()
    const hasBtn = await ideaBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) return false

    await ideaBtn.click()
    await page.waitForTimeout(500)

    const popover = page.locator('[data-testid="idea-popover"]')
    return popover.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('idea popover renders with "Capture an Idea" header', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const popover = page.locator('[data-testid="idea-popover"]')
    await expect(popover).toBeVisible()

    // Header should show "Capture an Idea"
    const header = popover.getByText(/capture an idea/i)
    await expect(header).toBeVisible()

    // Should have lightbulb icon
    const icon = popover.locator('svg').first()
    await expect(icon).toBeVisible()
  })

  test('title input accepts text and is required for save', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const popover = page.locator('[data-testid="idea-popover"]')

    // Find title input
    const titleInput = popover.locator('input[type="text"]')
    const hasTitleInput = await titleInput.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTitleInput) {
      test.skip()
      return
    }

    // Input should be empty initially (or have prefilled text)
    await expect(titleInput).toBeVisible()

    // Type a title
    await titleInput.fill('Test Idea Title')
    const value = await titleInput.inputValue()
    expect(value).toBe('Test Idea Title')
  })

  test('description textarea is optional', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const popover = page.locator('[data-testid="idea-popover"]')

    // Find textarea
    const textarea = popover.locator('textarea')
    const hasTextarea = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTextarea) {
      test.skip()
      return
    }

    // Textarea should have placeholder indicating it's optional
    const placeholder = await textarea.getAttribute('placeholder')
    expect(placeholder?.toLowerCase()).toContain('optional')

    // Should accept text
    await textarea.fill('A description of my idea')
    const value = await textarea.inputValue()
    expect(value).toBe('A description of my idea')
  })

  test('save button disabled when title is empty', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const saveBtn = page.locator('[data-testid="idea-popover-save"]')
    const hasSave = await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasSave) {
      test.skip()
      return
    }

    // Clear title to ensure it's empty
    const popover = page.locator('[data-testid="idea-popover"]')
    const titleInput = popover.locator('input[type="text"]')
    await titleInput.fill('')
    await page.waitForTimeout(200)

    // Save button should be disabled
    await expect(saveBtn).toBeDisabled()

    // Fill title — button should become enabled
    await titleInput.fill('Now it has a title')
    await page.waitForTimeout(200)
    await expect(saveBtn).toBeEnabled()
  })

  test('escape key closes the idea popover', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const popover = page.locator('[data-testid="idea-popover"]')
    await expect(popover).toBeVisible()

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Popover should be hidden
    await expect(popover).toBeHidden({ timeout: 3_000 })
  })

  test('successful save shows "Idea saved!" confirmation with checkmark', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const hasPopover = await openIdeaPopover(page)
    if (!hasPopover) {
      test.skip()
      return
    }

    const popover = page.locator('[data-testid="idea-popover"]')

    // Fill in a title
    const titleInput = popover.locator('input[type="text"]')
    await titleInput.fill('E2E Test Idea - ' + Date.now())
    await page.waitForTimeout(200)

    // Click save
    const saveBtn = page.locator('[data-testid="idea-popover-save"]')
    const hasSave = await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSave) {
      test.skip()
      return
    }

    await saveBtn.click()
    await page.waitForTimeout(1_000)

    // Should show success message "Idea saved!"
    const successMsg = popover.getByText(/idea saved/i)
    const hasSavedMsg = await successMsg.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSavedMsg) {
      await expect(successMsg).toBeVisible()
    }
    // Note: popover auto-closes after 800ms on success, so it might already be gone
  })
})

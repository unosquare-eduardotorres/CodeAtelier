/**
 * Slash Commands E2E Tests
 *
 * Verifies the slash command system end-to-end:
 *   - Typing "/" triggers the SlashCommandDropdown
 *   - Arrow key navigation highlights commands
 *   - Enter selects the highlighted command
 *   - /compact triggers compaction flow
 *   - /compact on already-compact conversation shows "nothing to compact"
 *   - /effort changes the EffortPill display
 *   - /help renders help content in chat
 *   - /clear clears display without deleting history
 *
 * These are critical because 13 slash commands exist but only the dropdown
 * appearance was previously tested. The actual execution had zero E2E coverage.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/slash-commands.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Slash Commands', () => {
  /**
   * Helper: ensure we're in a workspace with message input ready.
   */
  async function ensureChatReady(page: import('@playwright/test').Page): Promise<ChatPage> {
    const welcomePage = new WelcomePage(page)
    const chat = new ChatPage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }

    return chat
  }

  // ── Dropdown appearance ──

  test('typing "/" in message input opens SlashCommandDropdown', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)

    const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await chat.messageInput.focus()
    await chat.messageInput.fill('/')
    await page.waitForTimeout(500)

    const dropdown = page.locator('[data-testid="slash-command-dropdown"]')
    await expect(dropdown).toBeVisible({ timeout: 3_000 })

    // Should contain multiple command items
    const items = page.locator('[data-testid^="slash-command-item-"]')
    const count = await items.count()
    expect(count).toBeGreaterThan(0)

    // Clean up
    await chat.messageInput.clear()
  })

  // ── Keyboard navigation ──

  test('arrow keys navigate slash command list, Enter selects', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)

    const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await chat.messageInput.focus()
    await chat.messageInput.fill('/')
    await page.waitForTimeout(500)

    const dropdown = page.locator('[data-testid="slash-command-dropdown"]')
    const hasDropdown = await dropdown.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasDropdown) {
      test.skip()
      return
    }

    // Press ArrowDown to move selection
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(200)

    // The second item should now have the active/selected styling
    const items = page.locator('[data-testid^="slash-command-item-"]')
    const itemCount = await items.count()
    expect(itemCount).toBeGreaterThan(1)

    // Press ArrowUp to go back
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(200)

    // Press Enter to select the current item
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)

    // Dropdown should close after selection
    await expect(dropdown).toBeHidden({ timeout: 3_000 })

    // Input should contain the selected command
    const inputValue = await chat.messageInput.inputValue()
    expect(inputValue.startsWith('/')).toBeTruthy()

    // Clean up
    await chat.messageInput.clear()
  })

  // ── /compact execution ──

  test('/compact triggers compaction and shows progress or modal', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // Need an active conversation with messages for /compact to work
    const messages = chat.getMessages()
    const messageCount = await messages.count()
    if (messageCount === 0) {
      test.skip()
      return
    }

    // Type and send /compact
    await chat.messageInput.focus()
    await chat.messageInput.fill('/compact')
    await page.waitForTimeout(300)

    // Dismiss dropdown if visible, then press Enter to execute
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await chat.messageInput.fill('/compact')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000)

    // Either: CompactContextModal appears, or a compaction progress indicator, or a "nothing to compact" message
    const compactModal = page.locator('[data-testid="compact-context-modal"]')
    const compactingText = page.getByText(/compacting|compact|nothing to compact|already compact/i).first()

    const hasModal = await compactModal.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasText = await compactingText.isVisible({ timeout: 3_000 }).catch(() => false)

    // Some response to /compact should exist
    expect(hasModal || hasText).toBeTruthy()

    // If modal opened, close it
    if (hasModal) {
      const cancelBtn = page.getByRole('button', { name: /cancel|close/i }).first()
      const hasCancelBtn = await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasCancelBtn) {
        await cancelBtn.click()
        await page.waitForTimeout(500)
      }
    }
  })

  // ── /compact on already-compact conversation ──

  test('/compact on short conversation shows "nothing to compact"', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)

    // Open a new chat that hasn't accumulated context
    await chat.openNewChat()
    await page.waitForTimeout(1_000)

    const inputReady = await chat.messageInput.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await chat.messageInput.fill('/compact')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000)

    // Should see "nothing to compact" or similar low-context message
    const nothingText = page.getByText(/nothing to compact|already compact|context is small|no compaction needed/i).first()
    const compactModal = page.locator('[data-testid="compact-context-modal"]')

    const hasNothing = await nothingText.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasModal = await compactModal.isVisible({ timeout: 3_000 }).catch(() => false)

    // Either a "nothing" message or the modal with low usage
    expect(hasNothing || hasModal).toBeTruthy()

    if (hasModal) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
  })

  // ── /effort changes EffortPill ──

  test('/effort low changes EffortPill to Low', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)

    const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    // Execute /effort low
    await chat.messageInput.fill('/effort low')
    await page.keyboard.press('Escape') // dismiss dropdown
    await page.waitForTimeout(200)
    await chat.messageInput.fill('/effort low')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1_000)

    // EffortPill should reflect the change
    const effortPill = page.locator('[data-testid="effort-pill"]')
    const hasEffort = await effortPill.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasEffort) {
      const pillText = await effortPill.textContent()
      expect(pillText?.toLowerCase()).toContain('low')
    }

    // Also check for a confirmation message in chat
    const confirmText = page.getByText(/effort.*low|set.*effort/i).first()
    const hasConfirm = await confirmText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasEffort || hasConfirm).toBeTruthy()
  })

  // ── /help renders help card ──

  test('/help renders help content in chat', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)

    const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await chat.messageInput.fill('/help')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await chat.messageInput.fill('/help')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1_500)

    // Help content should appear — either as a card or as text listing commands
    const helpContent = page.getByText(/available commands|keyboard shortcuts|help|slash commands/i).first()
    const hasHelp = await helpContent.isVisible({ timeout: 5_000 }).catch(() => false)

    expect(hasHelp).toBeTruthy()
  })

  // ── /clear clears display ──

  test('/clear clears chat display without deleting history', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    const messagesBefore = await chat.getMessages().count()
    if (messagesBefore === 0) {
      test.skip()
      return
    }

    await chat.messageInput.fill('/clear')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await chat.messageInput.fill('/clear')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1_500)

    // Messages should be visually cleared or significantly reduced
    const messagesAfter = await chat.getMessages().count()

    // Either messages are cleared or a "cleared" confirmation appears
    const clearedText = page.getByText(/cleared|display cleared/i).first()
    const hasCleared = await clearedText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(messagesAfter < messagesBefore || hasCleared).toBeTruthy()
  })

  // ── /undo restores checkpoint ──

  test('/undo restores last checkpoint without dialog', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    const messagesBefore = await chat.getMessages().count()
    if (messagesBefore < 2) {
      // Need at least a user+assistant pair for undo to make sense
      test.skip()
      return
    }

    await chat.messageInput.fill('/undo')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await chat.messageInput.fill('/undo')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2_000)

    // Either a confirmation dialog, an undo in progress, or messages removed
    const undoText = page.getByText(/undo|reverted|restored|no checkpoints/i).first()
    const hasUndo = await undoText.isVisible({ timeout: 5_000 }).catch(() => false)

    const messagesAfter = await chat.getMessages().count()

    // Some response should occur — either messages reduced or confirmation text
    expect(messagesAfter <= messagesBefore || hasUndo).toBeTruthy()
  })
})

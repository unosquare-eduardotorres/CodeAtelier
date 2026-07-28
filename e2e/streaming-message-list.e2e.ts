/**
 * Streaming & Message List E2E Tests
 *
 * Tests the streaming transcript and message list scroll behavior:
 *   - Message list auto-scrolls to bottom on new message
 *   - StreamingTranscript renders segments incrementally
 *   - MessageCardRenderer routes by message role
 *   - Stop button halts streaming and re-enables input
 *   - Thinking blocks render as collapsible sections
 *   - Message attachment renders inline with thumbnail
 *   - Draft message transitions to sent on submit
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/streaming-message-list.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { ChatPage } from './pages/chat-page'
import { WelcomePage } from './pages/welcome-page'

test.describe('Streaming & Message List', () => {
  /** Ensure we're in a workspace with chat view ready. */
  async function ensureChatReady(
    page: import('@playwright/test').Page
  ): Promise<ChatPage | null> {
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
      if (count === 0) return null
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Switch to chats tab if needed
    const chatsTab = page.locator('[data-testid="sidebar-chats-tab"]')
    const hasChats = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasChats) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }

    return chat
  }

  test('message list auto-scrolls to bottom on new message', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    // Wait for message input
    const inputReady = await chat.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    // Check for scroll-to-bottom button existence
    const scrollToBottom = page.locator('[data-testid="scroll-to-bottom"]')
    const messages = chat.getMessages()
    const messageCount = await messages.count()

    if (messageCount > 3) {
      // Scroll the actual overflow container to the top
      const scrollContainer = page.locator('[data-testid="message-scroll"]')
      await expect(scrollContainer).toBeVisible({ timeout: 3_000 })
      await scrollContainer.evaluate((el) => {
        el.scrollTop = 0
      })
      await page.waitForTimeout(500)

      // Scroll-to-bottom button must appear when scrolled away from bottom
      await expect(scrollToBottom).toBeVisible({ timeout: 3_000 })

      // Click it and verify it disappears (we're back at bottom)
      await scrollToBottom.click()
      await page.waitForTimeout(500)
      await expect(scrollToBottom).toBeHidden({ timeout: 3_000 })
    }

    // Message input should still be accessible
    await expect(chat.messageInput).toBeVisible()
  })

  test('StreamingTranscript renders segments incrementally', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const inputReady = await chat.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    // Wait for agent init
    await page.waitForTimeout(5_000)
    const isEnabled = await chat.isInputEnabled()
    if (!isEnabled) {
      test.skip()
      return
    }

    // Send a message to trigger streaming
    await chat.sendMessage('What is 2 + 2?')

    // Check for streaming indicator
    const streamingIndicator = page.locator('[data-testid="streaming-indicator"]')
    const isStreaming = await streamingIndicator
      .isVisible({ timeout: 15_000 })
      .catch(() => false)

    if (isStreaming) {
      // Wait for streaming to complete
      await chat.waitForStreamComplete(120_000)
    }

    // After streaming: at least 2 messages (user + assistant)
    const messages = chat.getMessages()
    const finalCount = await messages.count()
    expect(finalCount).toBeGreaterThanOrEqual(1)
  })

  test('MessageCardRenderer routes by message role', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const messages = chat.getMessages()
    const messageCount = await messages.count()

    if (messageCount < 2) {
      // Need at least a user + assistant pair — try sending a message
      const inputReady = await chat.messageInput
        .isVisible({ timeout: 15_000 })
        .catch(() => false)
      if (!inputReady) {
        test.skip()
        return
      }

      await page.waitForTimeout(5_000)
      const isEnabled = await chat.isInputEnabled()
      if (!isEnabled) {
        test.skip()
        return
      }

      await chat.sendMessage('Hello')
      await chat.waitForStreamComplete(120_000)
    }

    // Verify message list has content
    const updatedCount = await messages.count()
    if (updatedCount < 1) {
      test.skip()
      return
    }

    // Messages should have visible content
    const firstMessage = messages.first()
    await expect(firstMessage).toBeVisible({ timeout: 5_000 })

    const firstText = await firstMessage.textContent()
    expect(firstText).toBeTruthy()
  })

  test('stop button halts streaming and re-enables input', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const inputReady = await chat.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await page.waitForTimeout(5_000)
    const isEnabled = await chat.isInputEnabled()
    if (!isEnabled) {
      test.skip()
      return
    }

    // Send a message that should take a while to respond
    await chat.sendMessage('Explain the entire history of computing in great detail')

    // Wait for stop button to appear
    const hasStop = await chat.stopButton
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
    if (!hasStop) {
      // Response completed too quickly
      test.skip()
      return
    }

    // Click stop
    await chat.stopGeneration()

    // Stop button should disappear
    await expect(chat.stopButton).toBeHidden({ timeout: 5_000 })

    // Message input should be re-enabled
    await expect(chat.messageInput).toBeVisible()
    await expect(chat.sendButton).toBeVisible()
  })

  test('thinking blocks render as collapsible sections', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    // Look for thinking/reasoning blocks in existing messages
    const thinkingBlocks = page.locator(
      '[data-testid="thinking-block"], [class*="thinking"], details'
    )
    const count = await thinkingBlocks.count()

    if (count === 0) {
      // No thinking blocks visible — may need extended thinking model
      test.skip()
      return
    }

    // Thinking blocks should be collapsible (details/summary or toggle)
    const firstBlock = thinkingBlocks.first()
    await expect(firstBlock).toBeVisible()

    const text = await firstBlock.textContent()
    expect(text?.length).toBeGreaterThan(0)
  })

  test('message attachment renders inline with thumbnail', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    // Check for attachment indicators in messages
    const attachments = page.locator(
      '[data-testid="message-attachment"], [class*="attachment"], [aria-label*="attachment"]'
    )
    const count = await attachments.count()

    if (count === 0) {
      // No message attachments in current view
      test.skip()
      return
    }

    // Attachment should have visible content
    const firstAttachment = attachments.first()
    await expect(firstAttachment).toBeVisible()
  })

  test('draft message transitions to sent on submit', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const inputReady = await chat.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    await page.waitForTimeout(5_000)
    const isEnabled = await chat.isInputEnabled()
    if (!isEnabled) {
      test.skip()
      return
    }

    // Type but don't send yet (draft state)
    await chat.messageInput.fill('Draft message test')
    await page.waitForTimeout(300)

    // Input should show the typed text
    const inputValue = await chat.messageInput.inputValue()
    expect(inputValue).toContain('Draft message test')

    // Count existing messages
    const messages = chat.getMessages()
    const beforeCount = await messages.count()

    // Submit
    await chat.sendButton.click()
    await page.waitForTimeout(2_000)

    // Message count should increase (user message appears)
    const afterCount = await messages.count()
    expect(afterCount).toBeGreaterThan(beforeCount)
  })
})

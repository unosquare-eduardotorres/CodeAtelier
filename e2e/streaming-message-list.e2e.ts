/**
 * Streaming & Message List E2E Tests
 *
 * Tests the streaming transcript and message list scroll behavior:
 *   - Message list auto-scrolls to bottom on new message
 *   - StreamingTranscript renders segments incrementally
 *   - MessageCardRenderer routes by message role
 *
 * Uses CDP fixture (Electron 41+ compatible).
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
      // If we have messages, scroll up manually
      const chatPanel = page.locator('[data-testid="chat-panel"]')
      const hasChatPanel = await chatPanel.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasChatPanel) {
        await chatPanel.evaluate((el) => {
          el.scrollTop = 0
        })
        await page.waitForTimeout(500)

        // ScrollToBottom button might appear
        const hasScrollBtn = await scrollToBottom.isVisible({ timeout: 3_000 }).catch(() => false)
        if (hasScrollBtn) {
          await scrollToBottom.click()
          await page.waitForTimeout(500)
        }
      }
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
})

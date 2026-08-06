/**
 * ChatPage — Page Object Model for the chat interface.
 *
 * Encapsulates selectors and actions for:
 *   - Chat panel and message list
 *   - Message input and send/stop buttons
 *   - Streaming indicator and completion detection
 *   - New chat page
 */
import type { Locator, Page } from '@playwright/test'

export class ChatPage {
  private readonly page: Page

  readonly chatPanel: Locator
  readonly messageInput: Locator
  readonly sendButton: Locator
  readonly stopButton: Locator
  readonly streamingIndicator: Locator
  readonly newChatPage: Locator

  constructor(page: Page) {
    this.page = page
    this.chatPanel = page.locator('[data-testid="chat-panel"]')
    this.messageInput = page.locator('[data-testid="message-input"]')
    this.sendButton = page.locator('[data-testid="send-button"]')
    this.stopButton = page.locator('[data-testid="stop-button"]')
    this.streamingIndicator = page.locator('[data-testid="streaming-indicator"]')
    this.newChatPage = page.locator('[data-testid="new-chat-page"]')
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Return all message elements in the message list. */
  getMessages(): Locator {
    return this.page.locator('[data-testid="message-bubble"], [data-testid="message-card"]')
  }

  /** Check if the message input is enabled and ready for typing. */
  async isInputEnabled(): Promise<boolean> {
    try {
      const isVisible = await this.messageInput.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!isVisible) return false
      return !(await this.messageInput.isDisabled())
    } catch {
      return false
    }
  }

  /** Check if the assistant is currently streaming a response. */
  async isStreaming(): Promise<boolean> {
    const hasIndicator = await this.streamingIndicator
      .isVisible({ timeout: 1_000 })
      .catch(() => false)
    const hasStop = await this.stopButton.isVisible({ timeout: 1_000 }).catch(() => false)
    return hasIndicator || hasStop
  }

  // ── Actions ──────────────────────────────────────────────────────

  /** Type a message and click send. */
  async sendMessage(text: string): Promise<void> {
    await this.messageInput.fill(text)
    await this.page.waitForTimeout(200)
    await this.sendButton.click()
    await this.page.waitForTimeout(500)
  }

  /**
   * Wait for streaming to complete (stop button disappears).
   * @param timeout Max wait time in ms (default: 60s)
   */
  async waitForStreamComplete(timeout = 60_000): Promise<void> {
    // First wait briefly for streaming to start
    await this.page.waitForTimeout(2_000)

    // Then wait for stop button / streaming indicator to disappear
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const isActive = await this.isStreaming()
      if (!isActive) return
      await this.page.waitForTimeout(1_000)
    }
  }

  /** Click the stop button to halt streaming. */
  async stopGeneration(): Promise<void> {
    const isVisible = await this.stopButton.isVisible({ timeout: 3_000 }).catch(() => false)
    if (isVisible) {
      await this.stopButton.click()
      await this.page.waitForTimeout(1_000)
    }
  }
}

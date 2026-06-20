/**
 * ChatPage POM — Chat panel interactions.
 *
 * Covers message input, streaming indicators, conversation sidebar,
 * mode switching, and message history.
 */
import type { Page, Locator } from '@playwright/test'

export class ChatPage {
  readonly page: Page

  // Chat panel elements
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

  /** Type text into the message input and send. */
  async sendMessage(text: string): Promise<void> {
    await this.messageInput.fill(text)
    await this.sendButton.click()
  }

  /** Wait for the streaming indicator to appear. */
  async waitForStreaming(timeout = 30_000): Promise<void> {
    await this.streamingIndicator.waitFor({ state: 'visible', timeout })
  }

  /** Wait for streaming to complete (indicator disappears). */
  async waitForStreamComplete(timeout = 120_000): Promise<void> {
    await this.streamingIndicator.waitFor({ state: 'hidden', timeout })
  }

  /** Click the stop button to interrupt streaming. */
  async stopGeneration(): Promise<void> {
    await this.stopButton.click()
    await this.page.waitForTimeout(500)
  }

  /** Get all message bubbles in the chat. */
  getMessages(): Locator {
    return this.page.locator('[data-testid="message-bubble"]')
  }

  /** Get the last message bubble. */
  getLastMessage(): Locator {
    return this.page.locator('[data-testid="message-bubble"]').last()
  }

  /** Switch conversation mode (plan/build/danger). */
  async switchMode(mode: 'plan' | 'build' | 'danger'): Promise<void> {
    const modeButton = this.page.getByRole('button', { name: new RegExp(mode, 'i') })
    await modeButton.click()
    await this.page.waitForTimeout(500)
  }

  /** Open a new chat via the sidebar button. */
  async openNewChat(): Promise<void> {
    const newChatBtn = this.page.getByRole('button', { name: /new chat/i })
    await newChatBtn.click()
    await this.page.waitForTimeout(500)
  }

  /** Click a conversation in the sidebar by title. */
  async openConversation(title: string): Promise<void> {
    const item = this.page.getByRole('button', {
      name: new RegExp(`Open conversation.*${title}`, 'i')
    })
    await item.click()
    await this.page.waitForTimeout(500)
  }

  /** Get the scroll-to-bottom button if visible. */
  getScrollToBottomButton(): Locator {
    return this.page.getByRole('button', { name: /scroll to latest/i })
  }

  /** Check if message input is enabled. */
  async isInputEnabled(): Promise<boolean> {
    return !(await this.messageInput.isDisabled())
  }

  /** Check if streaming is active (stop button visible). */
  async isStreaming(): Promise<boolean> {
    return this.stopButton.isVisible({ timeout: 1_000 }).catch(() => false)
  }
}

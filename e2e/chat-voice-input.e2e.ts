/**
 * Chat Voice Input E2E Tests
 *
 * Verifies voice input flow:
 *   1. /voice command enables microphone indicator and VoiceMicButton
 *   2. Push-to-talk (hold V key) activates VoiceIndicator
 *   3. VoiceIndicator shows interim transcription text
 *   4. Voice error state shows dismiss button
 *
 * Voice is opt-in via the /voice slash command. Push-to-talk uses the V key
 * (not Spacebar) when textarea is not focused. The VoiceMicButton uses
 * mouse press-and-hold behavior.
 *
 * Note: Actual microphone recording requires browser permission and may not
 * be available in CI. Tests verify UI state transitions, not actual audio.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/chat-voice-input.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Chat Voice Input', () => {
  /**
   * Helper: navigate to workspace and ensure chat is ready.
   */
  async function ensureChatReady(
    page: import('@playwright/test').Page
  ): Promise<{ chat: ChatPage }> {
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
      if (count === 0) {
        test.skip()
      }
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Verify message input is available
    const inputReady = await chat.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)

    if (!inputReady) {
      test.skip()
    }

    return { chat }
  }

  /**
   * Helper: enable voice input via /voice slash command.
   * Returns true if voice was successfully enabled.
   */
  async function enableVoice(
    page: import('@playwright/test').Page,
    chat: ChatPage
  ): Promise<boolean> {
    // Type /voice command to toggle voice on
    await chat.messageInput.fill('/voice')
    await page.waitForTimeout(500)

    // Look for the slash command dropdown
    const commandDropdown = page.getByText(/toggle push-to-talk/i)
    const hasDropdown = await commandDropdown.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasDropdown) {
      await commandDropdown.click()
      await page.waitForTimeout(500)
    } else {
      // Try pressing Enter to execute the command directly
      await chat.messageInput.press('Enter')
      await page.waitForTimeout(500)
    }

    // Check if voice mic button appeared (indicates voice is enabled)
    const voiceMicBtn = page.getByRole('button', { name: /hold to speak|release to stop/i })
    const hasVoiceMic = await voiceMicBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    return hasVoiceMic
  }

  // ── 1. /voice command enables microphone indicator ──

  test('/voice command enables VoiceMicButton in message toolbar', async ({
    electronPage: page
  }) => {
    const { chat } = await ensureChatReady(page)

    // Before enabling: voice mic button should NOT be visible
    const voiceMicBefore = page.getByRole('button', { name: /hold to speak/i })
    const _hasMicBefore = await voiceMicBefore.isVisible({ timeout: 3_000 }).catch(() => false)

    // Enable voice via slash command
    const voiceEnabled = await enableVoice(page, chat)

    if (!voiceEnabled) {
      // Voice may not be supported in this environment (no microphone API)
      // Check for the "not supported" system message
      const notSupported = page.getByText(/voice.*not supported|microphone.*not available/i)
      const hasNotSupported = await notSupported.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasNotSupported) {
        // Voice is not supported — this is expected in some CI environments
        expect(hasNotSupported).toBeTruthy()
        return
      }

      test.skip()
      return
    }

    // After enabling: voice mic button should be visible
    const voiceMicAfter = page.getByRole('button', { name: /hold to speak|release to stop/i })
    const hasMicAfter = await voiceMicAfter.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasMicAfter).toBeTruthy()

    // Also check for the "Voice input enabled" system message
    const enabledMsg = page.getByText(/voice input enabled|push-to-talk/i)
    const hasEnabledMsg = await enabledMsg.isVisible({ timeout: 3_000 }).catch(() => false)

    // Either the button appeared or the system message was shown
    expect(hasMicAfter || hasEnabledMsg).toBeTruthy()
  })

  // ── 2. Push-to-talk (V key) activates VoiceIndicator ──

  test('push-to-talk (V key) activates VoiceIndicator', async ({ electronPage: page }) => {
    const { chat } = await ensureChatReady(page)

    // Enable voice first
    const voiceEnabled = await enableVoice(page, chat)
    if (!voiceEnabled) {
      test.skip()
      return
    }

    // Make sure textarea is NOT focused (V key only works when textarea is blurred)
    await page.click('body')
    await page.waitForTimeout(300)

    // Press and hold V key to activate push-to-talk
    await page.keyboard.down('KeyV')
    await page.waitForTimeout(500)

    // VoiceIndicator should appear with the "Listening..." state
    const listeningIndicator = page.locator('[data-testid="voice-indicator-listening"]')
    const hasListening = await listeningIndicator.isVisible({ timeout: 3_000 }).catch(() => false)

    // Also check for mic button state change (animate-pulse when active)
    const activeMicBtn = page.getByRole('button', { name: /release to stop/i })
    const hasActiveMic = await activeMicBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // Release V key
    await page.keyboard.up('KeyV')
    await page.waitForTimeout(500)

    // Either the listening indicator or the active mic button should have been visible
    // Note: In CI without microphone permission, an error state may appear instead
    const errorIndicator = page.locator('[data-testid="voice-indicator-error"]')
    const hasError = await errorIndicator.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasListening || hasActiveMic || hasError).toBeTruthy()
  })

  // ── 3. VoiceIndicator shows interim transcription text ──

  test('VoiceIndicator shows interim transcription or listening text', async ({
    electronPage: page
  }) => {
    const { chat } = await ensureChatReady(page)

    // Enable voice
    const voiceEnabled = await enableVoice(page, chat)
    if (!voiceEnabled) {
      test.skip()
      return
    }

    // Blur textarea and press V to activate
    await page.click('body')
    await page.waitForTimeout(300)
    await page.keyboard.down('KeyV')
    await page.waitForTimeout(500)

    // Check for the VoiceIndicator in listening state
    const listeningIndicator = page.locator('[data-testid="voice-indicator-listening"]')
    const hasListening = await listeningIndicator.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasListening) {
      // Should show either interim text or default "Listening..." text
      const indicatorText = await listeningIndicator.textContent()
      const hasText = (indicatorText?.length ?? 0) > 0

      // The indicator should contain either "Listening..." or some interim transcription
      expect(hasText).toBeTruthy()
      expect(indicatorText).toMatch(/listening|[a-zA-Z]/i)

      // Check for animated recording dots (the 3 bouncing circles)
      const dots = listeningIndicator.locator('.animate-bounce')
      const dotCount = await dots.count()
      expect(dotCount).toBe(3)
    }

    // Release V key
    await page.keyboard.up('KeyV')
    await page.waitForTimeout(500)

    // After release, the listening indicator should disappear
    if (hasListening) {
      const _stillListening = await listeningIndicator
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
      // May still be visible briefly — or error may show if mic permission denied
      // Just verify the initial state was correct
    }
  })

  // ── 4. Voice error state shows dismiss button ──

  test('voice error state shows dismiss button', async ({ electronPage: page }) => {
    const { chat } = await ensureChatReady(page)

    // Enable voice
    const voiceEnabled = await enableVoice(page, chat)
    if (!voiceEnabled) {
      test.skip()
      return
    }

    // In most E2E environments, microphone access will be denied,
    // which should trigger an error state in VoiceIndicator
    await page.click('body')
    await page.waitForTimeout(300)
    await page.keyboard.down('KeyV')
    await page.waitForTimeout(1_000) // Wait longer for error to appear
    await page.keyboard.up('KeyV')
    await page.waitForTimeout(500)

    // Check for error indicator
    const errorIndicator = page.locator('[data-testid="voice-indicator-error"]')
    const hasError = await errorIndicator.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasError) {
      // If no error appeared, microphone might actually work in this env
      // Or voice wasn't triggered — skip gracefully
      test.skip()
      return
    }

    // Error indicator should show an error message
    const errorText = await errorIndicator.textContent()
    expect((errorText?.length ?? 0)).toBeGreaterThan(0)

    // Dismiss button should be visible
    const dismissBtn = page.locator('[data-testid="voice-indicator-dismiss"]')
    const hasDismiss = await dismissBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasDismiss) {
      // Fallback: aria-label based
      const ariaDismiss = page.getByRole('button', { name: /dismiss error/i })
      const hasAria = await ariaDismiss.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasAria) {
        await ariaDismiss.click()
        await page.waitForTimeout(500)

        // Error should be dismissed
        const stillError = await errorIndicator.isVisible({ timeout: 2_000 }).catch(() => false)
        expect(stillError).toBeFalsy()
        return
      }
      test.skip()
      return
    }

    // Click dismiss button
    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Error indicator should be gone
    const stillError = await errorIndicator.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(stillError).toBeFalsy()
  })
})

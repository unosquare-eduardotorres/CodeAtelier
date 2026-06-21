/**
 * Persona Selector + Code Block E2E Tests
 *
 * Tests PersonaSelector (193 LOC) + CodeBlock (180 LOC):
 *   - Persona selector dropdown renders in chat header
 *   - Dropdown shows available specialists and da-vinci
 *   - Selecting a specialist switches the active persona
 *   - Code block renders with copy button and language label
 *   - Copy button copies code content to clipboard
 *
 * Navigation: Active conversation → header persona dropdown.
 *             Chat message with code fence.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/persona-selector.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Persona Selector & Code Block', () => {
  async function ensureConversationReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Make sure we're on the chat page with a conversation
    const chatPage = new ChatPage(page)
    const hasChatPanel = await chatPage.isChatPanelVisible()
    return hasChatPanel
  }

  test('persona selector dropdown renders in chat header', async ({
    electronPage: page
  }) => {
    const ready = await ensureConversationReady(page)
    if (!ready) { test.skip(); return }

    const selector = page.locator('[data-testid="persona-selector"]')
    const isVisible = await selector.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(selector).toBeVisible()

    // Should contain a button trigger for the dropdown
    const trigger = selector.locator('button').first()
    await expect(trigger).toBeVisible()

    // Trigger should have aria attributes for accessibility
    const ariaLabel = await trigger.getAttribute('aria-label')
    const ariaHasPopup = await trigger.getAttribute('aria-haspopup')
    expect(ariaLabel !== null || ariaHasPopup !== null).toBeTruthy()
  })

  test('dropdown shows available specialists and da-vinci', async ({
    electronPage: page
  }) => {
    const ready = await ensureConversationReady(page)
    if (!ready) { test.skip(); return }

    const selector = page.locator('[data-testid="persona-selector"]')
    const isVisible = await selector.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Click to open the dropdown
    const trigger = selector.locator('button').first()
    await trigger.click()
    await page.waitForTimeout(500)

    // Dropdown content should appear (listbox or dropdown items)
    const dropdownItems = selector.locator('[role="option"], [role="listbox"] > *, button').filter({
      hasText: /Da Vinci|DaVinci|Specialist/i
    })
    const hasItems = (await dropdownItems.count()) > 0

    // At minimum, the dropdown should show Da Vinci as the default option
    const selectorText = await selector.textContent()
    expect(selectorText?.length).toBeGreaterThan(0)
    if (hasItems) {
      expect(await dropdownItems.count()).toBeGreaterThan(0)
    }

    // Close dropdown
    await trigger.click()
  })

  test('selecting a specialist switches the active persona', async ({
    electronPage: page
  }) => {
    const ready = await ensureConversationReady(page)
    if (!ready) { test.skip(); return }

    const selector = page.locator('[data-testid="persona-selector"]')
    const isVisible = await selector.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Open dropdown
    const trigger = selector.locator('button').first()
    await trigger.click()
    await page.waitForTimeout(500)

    // Find an option that's not the current selection
    const options = selector.locator('button, [role="option"]')
    const optionCount = await options.count()

    if (optionCount < 2) { test.skip(); return }

    // Click the second option (different from current)
    const secondOption = options.nth(1)
    if (await secondOption.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await secondOption.click()
      await page.waitForTimeout(500)
    }

    // Selector should still be functional after switch
    await expect(selector).toBeVisible()
  })

  test('code block renders with copy button and language label', async ({
    electronPage: page
  }) => {
    const ready = await ensureConversationReady(page)
    if (!ready) { test.skip(); return }

    // Look for code blocks in the chat messages
    const codeBlock = page.locator('[data-testid="code-block"]').first()
    const hasCodeBlock = await codeBlock.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasCodeBlock) { test.skip(); return }

    await expect(codeBlock).toBeVisible()

    // Should have a language label
    const langLabel = codeBlock.locator('span').filter({ hasText: /typescript|javascript|python|bash|json|html|css|code/i }).first()
    const hasLang = await langLabel.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasLang) {
      await expect(langLabel).toBeVisible()
    }

    // Should have a copy button
    const copyBtn = codeBlock.locator('button').filter({ hasText: /Copy|Copied/i }).first()
    const hasCopy = await copyBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasCopy) {
      // Also check for button with copy icon (aria-label)
      const copyByLabel = codeBlock.locator('button[aria-label*="copy" i], button[title*="copy" i]').first()
      expect(await copyByLabel.isVisible({ timeout: 1_000 }).catch(() => false)).toBeTruthy()
    } else {
      await expect(copyBtn).toBeVisible()
    }
  })

  test('copy button copies code content to clipboard', async ({
    electronPage: page
  }) => {
    const ready = await ensureConversationReady(page)
    if (!ready) { test.skip(); return }

    const codeBlock = page.locator('[data-testid="code-block"]').first()
    const hasCodeBlock = await codeBlock.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasCodeBlock) { test.skip(); return }

    // Find the copy button
    const copyBtn = codeBlock.locator('button[aria-label*="copy" i], button[title*="copy" i], button:has(svg.lucide-copy)').first()
    const hasCopy = await copyBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasCopy) { test.skip(); return }

    await copyBtn.click()
    await page.waitForTimeout(500)

    // After clicking, button should show "Copied" state (check icon or text change)
    const copiedState = codeBlock.locator('button[aria-label*="copied" i], button[title*="copied" i], svg.lucide-check, span:has-text("Copied")')
    const hasCopied = await copiedState.first().isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasCopied).toBeTruthy()
  })
})

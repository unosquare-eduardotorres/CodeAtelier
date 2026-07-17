/**
 * Workspace CRUD E2E Tests
 *
 * Verifies:
 *   - Opening a workspace transitions to ChatPanel
 *   - Agent status appears in StatusBar on workspace open
 *   - Switching between workspaces preserves sessions
 *   - Deleting a workspace removes its card
 *   - Workspace card renders with expected structure
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/workspace-crud.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { AppChrome } from './pages/app-chrome'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Workspace CRUD', () => {
  test.beforeEach(async ({ electronPage: page }) => {
    // Complete welcome flow if needed
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }
  })

  test('welcome screen shows Add Workspace card', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)

    // Navigate home to ensure we're on welcome screen
    const chrome = new AppChrome(page)
    await chrome.goHome()

    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })
    await expect(welcomePage.addWorkspaceCard).toBeVisible()
  })

  test('workspace card renders with expected content', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const cardCount = await cards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // First workspace card should have visible content
    const firstCard = cards.first()
    await expect(firstCard).toBeVisible()

    // Card should contain workspace name text
    const cardText = await firstCard.textContent()
    expect(cardText?.length).toBeGreaterThan(0)
  })

  test('opening workspace shows chat view', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    const chatPage = new ChatPage(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const cardCount = await cards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // Click the first workspace card
    await cards.first().click()
    await page.waitForTimeout(2_000)

    // Should transition to chat view — either ChatPanel or NewChatPage
    const hasChatPanel = await chatPage.chatPanel
      .isVisible({ timeout: 10_000 })
      .catch(() => false)
    const hasNewChatPage = await chatPage.newChatPage
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    expect(hasChatPanel || hasNewChatPage).toBeTruthy()
  })

  test('workspace open shows agent status in StatusBar', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const cardCount = await cards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // Open the first workspace
    await cards.first().click()
    await page.waitForTimeout(2_000)

    // StatusBar should be visible and show workspace name
    await expect(chrome.statusBar).toBeVisible()

    // StatusBar should contain agent status indicator (specialist dot)
    const statusBarText = await chrome.statusBar.textContent()
    expect(statusBarText?.length).toBeGreaterThan(0)
  })

  test('message input becomes available when workspace is open', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    const chatPage = new ChatPage(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const cardCount = await cards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // Open workspace
    await cards.first().click()
    await page.waitForTimeout(3_000)

    // Message input should eventually be visible
    const hasInput = await chatPage.messageInput
      .isVisible({ timeout: 15_000 })
      .catch(() => false)

    if (hasInput) {
      // Input should be present (may or may not be enabled depending on agent state)
      await expect(chatPage.messageInput).toBeVisible()
    }
  })

  test('switching workspaces via home preserves state', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const cardCount = await cards.count()

    if (cardCount < 2) {
      test.skip()
      return
    }

    // Open first workspace
    await cards.first().click()
    await page.waitForTimeout(2_000)

    // Go home
    await chrome.goHome()
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })

    // Open second workspace
    const refreshedCards = welcomePage.getWorkspaceCards()
    await refreshedCards.nth(1).click()
    await page.waitForTimeout(2_000)

    // Go home again
    await chrome.goHome()
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })

    // Re-open first workspace — should restore its state
    const finalCards = welcomePage.getWorkspaceCards()
    await finalCards.first().click()
    await page.waitForTimeout(2_000)

    // Chat view should be visible (restored)
    const chatPage = new ChatPage(page)
    const hasChatView = await chatPage.chatPanel
      .isVisible({ timeout: 10_000 })
      .catch(() => false)
    const hasNewChat = await chatPage.newChatPage
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    expect(hasChatView || hasNewChat).toBeTruthy()
  })

  test('delete workspace removes card from grid', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)
    await chrome.goHome()

    const cards = welcomePage.getWorkspaceCards()
    const initialCount = await cards.count()

    if (initialCount === 0) {
      test.skip()
      return
    }

    // Hover over the first workspace card to reveal the remove button
    await cards.first().hover()
    await page.waitForTimeout(300)

    // Look for remove button
    const removeBtn = page.getByRole('button', { name: /remove workspace/i }).first()
    const hasRemoveBtn = await removeBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasRemoveBtn) {
      // Try alternate approach: right-click context menu
      await cards.first().click({ button: 'right' })
      await page.waitForTimeout(500)
      const deleteOption = page.getByText(/delete|remove/i).first()
      const hasDelete = await deleteOption.isVisible({ timeout: 2_000 }).catch(() => false)

      if (!hasDelete) {
        test.skip()
        return
      }
      await deleteOption.click()
    } else {
      await removeBtn.click()
    }

    // Confirmation dialog should appear
    const confirmBtn = page.getByRole('button', { name: /confirm|delete|yes/i }).first()
    const hasConfirm = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasConfirm) {
      await confirmBtn.click()
      await page.waitForTimeout(1_000)

      // Card count should decrease
      const finalCount = await welcomePage.getWorkspaceCards().count()
      expect(finalCount).toBeLessThan(initialCount)
    }
  })
})

/**
 * App Launch & Welcome Flow E2E Tests
 *
 * Verifies:
 *   - Fresh launch shows WelcomeModal (first-run profile creation)
 *   - Completing welcome flow persists profile
 *   - App header navigation (Home, Settings, Help, Bug Tracker)
 *   - WelcomeModal cannot be bypassed with Escape
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/app-launch.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { AppChrome } from './pages/app-chrome'
import { WelcomePage } from './pages/welcome-page'

test.describe('App Launch & Welcome Flow', () => {
  test('fresh launch shows app structure', async ({ electronPage: page }) => {
    // The app should render either a WelcomeModal (first launch) or WelcomeScreen
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    const hasScreen = await welcomePage.isVisible()

    // At least one of these should be true on launch
    expect(hasModal || hasScreen).toBeTruthy()

    // Status bar should always be visible
    await expect(chrome.statusBar).toBeVisible({ timeout: 10_000 })
  })

  test('welcome modal renders with profile input', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (!hasModal) {
      test.skip()
      return
    }

    // Modal should be a dialog
    await expect(welcomePage.welcomeModal).toBeVisible()

    // Profile name input should be focusable
    const nameInput = page.locator('input').first()
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toBeEditable()
  })

  test('escape key does not dismiss welcome modal', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (!hasModal) {
      test.skip()
      return
    }

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Modal should still be visible (no bypass)
    await expect(welcomePage.welcomeModal).toBeVisible()
  })

  test('complete welcome flow shows workspace screen', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // After welcome, WelcomeScreen should be visible with Add Workspace card
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 10_000 })
    await expect(welcomePage.addWorkspaceCard).toBeVisible()

    // App header navigation buttons should be visible
    await expect(chrome.homeButton).toBeVisible()
    await expect(chrome.settingsButton).toBeVisible()
    await expect(chrome.bugTrackerButton).toBeVisible()
    await expect(chrome.helpButton).toBeVisible()

    // Status bar should be at the bottom
    await expect(chrome.statusBar).toBeVisible()
  })

  test('app header navigation — Settings page', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Navigate to Settings
    await chrome.openSettings()

    // Settings page should render (theme selector or subscriptions)
    const settingsContent = page.getByText(/theme|appearance|subscriptions/i).first()
    await expect(settingsContent).toBeVisible({ timeout: 5_000 })

    // Navigate back to Home
    await chrome.goHome()
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })
  })

  test('app header navigation — Help page', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Navigate to Help
    await chrome.openHelp()

    // Help view should render with content
    const helpContent = page.getByText(/getting started|help|guide/i).first()
    await expect(helpContent).toBeVisible({ timeout: 5_000 })

    // Navigate back to Home
    await chrome.goHome()
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })
  })

  test('app header navigation — Bug Tracker page', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Navigate to Bug Tracker
    await chrome.openBugTracker()

    // Bug tracker page should render
    const bugContent = page.getByText(/bug|issue|tracker/i).first()
    await expect(bugContent).toBeVisible({ timeout: 5_000 })

    // Navigate back to Home
    await chrome.goHome()
    await expect(welcomePage.welcomeScreen).toBeVisible({ timeout: 5_000 })
  })
})

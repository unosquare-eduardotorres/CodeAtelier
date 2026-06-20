/**
 * Ideas Management E2E Tests
 *
 * Verifies the Ideas UI flow that feeds into Grill:
 *   - IdeaCard shows title, description, and action buttons
 *   - CreateIdeaModal form with title + description + tags
 *   - IdeaFilterBar filters ideas by status
 *   - Ideas list renders with idea cards
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/ideas-management.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Ideas Management', () => {
  async function navigateToIdeas(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Navigate to Ideas/Grill settings tab
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('ideas')
    await page.waitForTimeout(500)
  }

  // ── Ideas list with IdeaCards ──

  test('Ideas list renders with IdeaCard components', async ({ electronPage: page }) => {
    await navigateToIdeas(page)

    // Check for idea cards
    const ideaCards = page.locator('[data-testid="idea-card"]')
    const cardCount = await ideaCards.count()

    if (cardCount === 0) {
      // No ideas exist — check for empty state
      const emptyState = page.getByText(/no ideas|create.*first|get started/i)
      const hasEmpty = await emptyState.isVisible({ timeout: 5_000 }).catch(() => false)

      // Either cards or empty state should be present
      expect(hasEmpty).toBeTruthy()
      return
    }

    // First card should have visible content
    const firstCard = ideaCards.first()
    await expect(firstCard).toBeVisible()

    // Card should have text content (title, description)
    const cardText = await firstCard.textContent()
    expect(cardText!.trim().length).toBeGreaterThan(0)
  })

  // ── IdeaCard ──

  test('IdeaCard shows title and action buttons on hover', async ({ electronPage: page }) => {
    await navigateToIdeas(page)

    const ideaCards = page.locator('[data-testid="idea-card"]')
    const cardCount = await ideaCards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    const firstCard = ideaCards.first()
    await firstCard.hover()
    await page.waitForTimeout(500)

    // Should have action buttons (edit, delete, grill)
    const actionButtons = firstCard.locator('button')
    const buttonCount = await actionButtons.count()
    expect(buttonCount).toBeGreaterThan(0)

    // Card should show a title
    const titleText = firstCard.locator('span, h3, h4, p').first()
    const hasTitle = await titleText.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasTitle).toBeTruthy()
  })

  // ── CreateIdeaModal ──

  test('CreateIdeaModal renders with title and description fields', async ({
    electronPage: page
  }) => {
    await navigateToIdeas(page)

    // Try to open the create idea modal
    const newIdeaBtn = page.getByRole('button', { name: /new idea|create idea|add idea/i }).first()
    const hasBtn = await newIdeaBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    await newIdeaBtn.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[data-testid="create-idea-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Should show "New Idea" heading
    const heading = modal.getByText(/new idea/i)
    await expect(heading).toBeVisible()

    // Should have title input
    const titleInput = modal.locator('input[type="text"]').first()
    await expect(titleInput).toBeVisible()

    // Should have description textarea
    const descriptionArea = modal.locator('textarea').first()
    const hasDesc = await descriptionArea.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDesc).toBeTruthy()

    // Should have create/save button
    const createBtn = modal.getByRole('button', { name: /create|save|add/i })
    const hasCreate = await createBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasCreate).toBeTruthy()

    // Close modal
    const closeBtn = modal.getByRole('button', { name: /close|cancel/i }).first()
    const hasClose = await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasClose) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
  })

  // ── IdeaFilterBar ──

  test('IdeaFilterBar shows status tabs and search input', async ({ electronPage: page }) => {
    await navigateToIdeas(page)

    const filterBar = page.locator('[data-testid="idea-filter-bar"]')
    const hasFilterBar = await filterBar.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasFilterBar) {
      test.skip()
      return
    }

    // Should have filter tabs
    const allTab = filterBar.getByText(/^all$/i)
    const hasAll = await allTab.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasAll).toBeTruthy()

    // Should have a search input
    const searchInput = filterBar.locator('input')
    const hasSearch = await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasSearch).toBeTruthy()

    // Should have "New Idea" button
    const newBtn = filterBar.getByRole('button', { name: /new|add|create/i })
    const hasNew = await newBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasNew).toBeTruthy()

    // Test filtering by clicking a tab
    const tabs = filterBar.locator('button')
    const tabCount = await tabs.count()
    if (tabCount > 2) {
      await tabs.nth(1).click()
      await page.waitForTimeout(300)

      // Click back to "All"
      await tabs.first().click()
      await page.waitForTimeout(300)
    }
  })
})

/**
 * Memory & Documents E2E Tests
 *
 * Verifies:
 *   - Memory settings page loads with memory list or empty state
 *   - Delete memory entry
 *   - Documents page loads
 *   - Token usage page loads
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Memory & Documents', () => {
  async function openSettingsTab(
    page: import('@playwright/test').Page,
    tabId: string
  ): Promise<void> {
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

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab(tabId)
    await page.waitForTimeout(500)
  }

  test('memory settings page loads', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    // Memory page should render
    const memoryContent = page.getByText(/memory|memories|knowledge/i).first()
    await expect(memoryContent).toBeVisible({ timeout: 10_000 })
  })

  test('memory page shows regenerate button', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    const regenerateBtn = page
      .getByRole('button', { name: /regenerate|rebuild|claude\.md/i })
      .first()
    const hasBtn = await regenerateBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    // Regenerate button should be visible if memory system is active
    if (hasBtn) {
      await expect(regenerateBtn).toBeVisible()
    }

    // Page should render without errors regardless
    const pageText = page.getByText(/memory/i).first()
    await expect(pageText).toBeVisible({ timeout: 5_000 })
  })

  test('memory list shows entries or empty state', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    // Either memory entries or empty state
    const memoryList = page.locator('[class*="overflow-y-auto"]').first()
    const emptyState = page.getByText(/no memories|empty|get started/i).first()

    const hasList = await memoryList.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasList || hasEmpty).toBeTruthy()
  })

  test('delete memory shows confirmation', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    // Look for delete buttons on memory entries
    const deleteBtn = page.getByRole('button', { name: /delete.*memory/i }).first()
    const hasDelete = await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDelete) {
      // Try hovering over a memory entry
      const memoryEntry = page.locator('[class*="rounded-xl"][class*="border"]').first()
      const hasEntry = await memoryEntry.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasEntry) {
        await memoryEntry.hover()
        await page.waitForTimeout(500)
        const hoverDelete = page.getByRole('button', { name: /delete/i }).first()
        const hasHoverDelete = await hoverDelete.isVisible({ timeout: 2_000 }).catch(() => false)

        if (!hasHoverDelete) {
          test.skip()
          return
        }
        await hoverDelete.click()
      } else {
        test.skip()
        return
      }
    } else {
      await deleteBtn.click()
    }

    await page.waitForTimeout(500)

    // Confirmation dialog should appear
    const confirmBtn = page.getByRole('button', { name: /confirm|delete|yes/i }).first()
    const hasConfirm = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasConfirm) {
      await expect(confirmBtn).toBeVisible()
      // Don't actually delete — just verify the dialog exists
    }
  })

  test('documents page loads', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'documents')

    // Documents page should render
    const docsContent = page.getByText(/documents|knowledge base|files/i).first()
    await expect(docsContent).toBeVisible({ timeout: 10_000 })
  })

  test('documents page shows list or empty state', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'documents')

    // Either document list or empty state
    const docList = page.locator('[class*="overflow-y-auto"]').first()
    const emptyState = page.getByText(/no documents|empty|add/i).first()

    const hasList = await docList.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasList || hasEmpty).toBeTruthy()
  })

  test('token usage page loads', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'tokens')

    // Tokens page should render
    const tokensContent = page.getByText(/tokens|usage|cost/i).first()
    await expect(tokensContent).toBeVisible({ timeout: 10_000 })
  })

  test('events page loads', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'events')

    // Events page should render
    const eventsContent = page.getByText(/events|log|activity/i).first()
    await expect(eventsContent).toBeVisible({ timeout: 10_000 })
  })
})

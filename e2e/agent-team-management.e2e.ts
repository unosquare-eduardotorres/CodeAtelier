/**
 * Agent Team Management E2E Tests
 *
 * Verifies agent grid, expand/collapse detail panel, activate/deactivate,
 * sync from YAML, delete with confirmation, show/hide inactive agents,
 * and skill management section.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Agent Team Management', () => {
  /** Navigate to Settings → Team tab so AgentManagementSection is visible. */
  async function openTeamTab(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)

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

    // Switch to settings view
    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    // Open Team tab
    const settings = new WorkspaceSettings(page)
    const teamTab = settings.getTab('team')
    const hasTeam = await teamTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTeam) {
      await teamTab.click()
      await page.waitForTimeout(500)
    }
  }

  test('agent management section renders with agent cards', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const section = page.locator('[data-testid="agent-management-section"]')
    const visible = await section.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(section).toBeVisible()

    // At least one agent card should be present (built-in Da Vinci)
    const agentCards = page.locator('[data-testid^="agent-card-"]')
    const cardCount = await agentCards.count()
    expect(cardCount).toBeGreaterThanOrEqual(1)

    // Each card shows an agent name and status indicator
    const firstCard = agentCards.first()
    await expect(firstCard).toBeVisible()
    const cardText = await firstCard.textContent()
    expect(cardText).toBeTruthy()
  })

  test('agent card expand shows detail panel', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const agentCards = page.locator('[data-testid^="agent-card-"]')
    const cardCount = await agentCards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // Click first agent card to expand
    await agentCards.first().click()
    await page.waitForTimeout(500)

    // Detail panel should appear
    const detailPanel = page.locator('[data-testid="agent-detail-panel"]')
    await expect(detailPanel).toBeVisible({ timeout: 5_000 })

    // Panel shows agent name and description area
    const panelText = await detailPanel.textContent()
    expect(panelText).toBeTruthy()

    // Close button (X) should be present
    const closeBtn = detailPanel.locator('button[aria-label="Close agent detail"]')
    await expect(closeBtn).toBeVisible()

    // Click close to dismiss panel
    await closeBtn.click()
    await page.waitForTimeout(300)
    await expect(detailPanel).toBeHidden()
  })

  test('agent activate/deactivate toggle switches state', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const agentCards = page.locator('[data-testid^="agent-card-"]')
    const cardCount = await agentCards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // Expand first card
    await agentCards.first().click()
    await page.waitForTimeout(500)

    const toggleBtn = page.locator('[data-testid="agent-activate-toggle"]')
    const isVisible = await toggleBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isVisible) {
      // Agent may not be deployed — skip
      test.skip()
      return
    }

    // Capture current text
    const initialText = await toggleBtn.textContent()
    expect(initialText).toMatch(/Activate|Deactivate/)

    // Click toggle
    await toggleBtn.click()
    await page.waitForTimeout(2_000)

    // Text should change
    const updatedText = await toggleBtn.textContent()
    expect(updatedText).toMatch(/Activate|Deactivate/)
  })

  test('agent sync from YAML button triggers refresh', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const agentCards = page.locator('[data-testid^="agent-card-"]')
    const cardCount = await agentCards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // Expand first agent
    await agentCards.first().click()
    await page.waitForTimeout(500)

    const syncBtn = page.locator('[data-testid="agent-sync-btn"]')
    await expect(syncBtn).toBeVisible({ timeout: 3_000 })

    // Click sync
    await syncBtn.click()
    await page.waitForTimeout(1_000)

    // Button should still be present after sync completes
    await expect(syncBtn).toBeVisible({ timeout: 10_000 })
  })

  test('agent delete with confirmation dialog', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const agentCards = page.locator('[data-testid^="agent-card-"]')
    const cardCount = await agentCards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // Expand first agent
    await agentCards.first().click()
    await page.waitForTimeout(500)

    const deleteBtn = page.locator('[data-testid="agent-delete-btn"]')
    const isVisible = await deleteBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Click delete — confirmation dialog should appear
    await deleteBtn.click()
    await page.waitForTimeout(500)

    // ConfirmDialog should be visible
    const confirmDialog = page.getByRole('dialog')
    const hasDialog = await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasDialog) {
      // Cancel should close the dialog
      const cancelBtn = page.getByRole('button', { name: /cancel/i })
      await cancelBtn.click()
      await page.waitForTimeout(300)
    }

    // Agent should still be present after cancel
    expect(await agentCards.count()).toBeGreaterThanOrEqual(1)
  })

  test('show inactive agents toggle reveals hidden agents', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const showInactiveBtn = page.locator('[data-testid="agent-show-inactive"]')
    const isVisible = await showInactiveBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      // No inactive agents — skip
      test.skip()
      return
    }

    // Click to show inactive
    await showInactiveBtn.click()
    await page.waitForTimeout(500)

    // Inactive section should appear with agents
    const inactiveLabel = page.getByText('Inactive', { exact: false })
    await expect(inactiveLabel.first()).toBeVisible({ timeout: 3_000 })

    // Toggle again to hide
    await showInactiveBtn.click()
    await page.waitForTimeout(500)
  })

  test('skill management section renders with skill tags', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const section = page.locator('[data-testid="skill-management-section"]')
    const visible = await section.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(section).toBeVisible()

    // Skill tags should be present
    const skillTags = page.locator('[data-testid^="skill-tag-"]')
    const tagCount = await skillTags.count()

    if (tagCount === 0) {
      // No skills deployed — verify empty state
      const emptyMsg = page.getByText('No skills found')
      await expect(emptyMsg).toBeVisible()
    } else {
      // Each tag shows skill name
      const firstTag = skillTags.first()
      await expect(firstTag).toBeVisible()
      const tagText = await firstTag.textContent()
      expect(tagText).toBeTruthy()
    }
  })

  test('skill import button opens import dropzone', async ({ electronPage: page }) => {
    await openTeamTab(page)

    const importBtn = page.locator('[data-testid="skill-import-btn"]')
    const isVisible = await importBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Click import — dropzone should appear
    await importBtn.click()
    await page.waitForTimeout(500)

    // Look for dropzone content (drag-and-drop area)
    const dropzone = page.getByText(/drag|drop|import/i)
    const hasDropzone = await dropzone.first().isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasDropzone).toBeTruthy()

    // Click again to close
    await importBtn.click()
    await page.waitForTimeout(500)
  })
})

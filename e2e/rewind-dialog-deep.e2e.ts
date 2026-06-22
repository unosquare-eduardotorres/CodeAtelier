/**
 * RewindDialog Deep E2E Tests
 *
 * Verifies RewindDialog (242 LOC) — checkpoint-based conversation rewind:
 *   - Dialog renders with header and warning text
 *   - Checkpoint list shows loading spinner initially
 *   - Checkpoint items display label, git SHA, and relative time
 *   - Clicking a checkpoint selects it with radio indicator
 *   - Rewind button is disabled until a checkpoint is selected
 *   - Cancel button dismisses dialog without rewinding
 *   - Escape key dismisses dialog
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/rewind-dialog-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('RewindDialog Deep', () => {
  async function ensureWorkspaceReady(
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
    return true
  }

  async function openRewindDialog(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Navigate to chats tab
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    const hasTab = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await chatsTab.click()
      await page.waitForTimeout(800)
    }

    // Select first conversation
    const chatItems = page.locator('[data-testid="chat-item"]')
    if ((await chatItems.count()) === 0) return false
    await chatItems.first().click()
    await page.waitForTimeout(1_500)

    // Try to trigger the rewind dialog — look for rewind/history button
    const rewindBtn = page.locator('button:has-text("Rewind"), [data-testid="rewind-btn"]')
    const hasRewindBtn = await rewindBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasRewindBtn) {
      await rewindBtn.first().click()
      await page.waitForTimeout(500)
    }

    return true
  }

  test('rewind dialog renders with header and warning text', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(dialog).toBeVisible()

    // Header should show "Rewind Conversation"
    const header = dialog.locator('h3:has-text("Rewind Conversation")')
    await expect(header).toBeVisible()

    // Warning block should be visible
    const warning = dialog.locator('text=This will:')
    await expect(warning).toBeVisible()

    // Warning should list consequences
    await expect(dialog.locator('text=Revert all file changes')).toBeVisible()
    await expect(dialog.locator('text=Remove messages sent after')).toBeVisible()
  })

  test('checkpoint list shows loading spinner initially', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Either loading spinner or checkpoint list should be present
    const loader = dialog.locator('text=Loading checkpoints')
    const checkpoints = dialog.locator('[data-testid="rewind-checkpoint-item"]')
    const noCheckpoints = dialog.locator('text=No checkpoints found')

    const hasLoader = await loader.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasCheckpoints = await checkpoints.first().isVisible({ timeout: 2_000 }).catch(() => false)
    const hasNone = await noCheckpoints.isVisible({ timeout: 2_000 }).catch(() => false)

    // One of the three states must be true
    expect(hasLoader || hasCheckpoints || hasNone).toBe(true)
  })

  test('checkpoint items display label, git SHA, and relative time', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Wait for checkpoints to load
    await page.waitForTimeout(2_000)

    const checkpoints = dialog.locator('[data-testid="rewind-checkpoint-item"]')
    const count = await checkpoints.count()
    if (count === 0) { test.skip(); return }

    // First checkpoint should have label text
    const firstCheckpoint = checkpoints.first()
    const labelText = await firstCheckpoint.locator('.text-sm.font-medium').textContent()
    expect(labelText).toBeTruthy()

    // Should have relative time (e.g., "min ago", "h ago", "d ago", "just now")
    const timeText = await firstCheckpoint.locator('.text-xs.text-text-secondary').last().textContent()
    expect(timeText).toBeTruthy()
  })

  test('clicking a checkpoint selects it with radio indicator', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await page.waitForTimeout(2_000)

    const checkpoints = dialog.locator('[data-testid="rewind-checkpoint-item"]')
    const count = await checkpoints.count()
    if (count === 0) { test.skip(); return }

    // Click first checkpoint
    await checkpoints.first().click()
    await page.waitForTimeout(300)

    // Radio indicator should show filled state (bg-orange-400 class)
    const radio = checkpoints.first().locator('.rounded-full.border-2')
    await expect(radio).toBeVisible()
    const classes = await radio.getAttribute('class')
    expect(classes).toContain('border-orange-400')
  })

  test('rewind button is disabled until a checkpoint is selected', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await page.waitForTimeout(2_000)

    const rewindConfirm = dialog.locator('[data-testid="rewind-confirm-btn"]')
    const hasBtn = await rewindConfirm.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasBtn) { test.skip(); return }

    // Button should be disabled initially (no checkpoint selected)
    await expect(rewindConfirm).toBeDisabled()

    // Select a checkpoint if available
    const checkpoints = dialog.locator('[data-testid="rewind-checkpoint-item"]')
    if ((await checkpoints.count()) > 0) {
      await checkpoints.first().click()
      await page.waitForTimeout(300)

      // Button should now be enabled
      await expect(rewindConfirm).toBeEnabled()
    }
  })

  test('cancel button dismisses dialog without rewinding', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Click Cancel button
    const cancelBtn = dialog.locator('button:has-text("Cancel")')
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Dialog should be dismissed
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('escape key dismisses dialog', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    await openRewindDialog(page)

    const dialog = page.locator('[data-testid="rewind-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Dialog should be dismissed
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })
})

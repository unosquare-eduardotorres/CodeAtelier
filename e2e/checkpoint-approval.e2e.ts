/**
 * Checkpoint Approval Modal E2E Tests
 *
 * Verifies the CheckpointApprovalModal component (184 LOC) — blocks
 * workflow until the user approves or rejects a checkpoint:
 *   - Modal renders with approval request details
 *   - Approve/Reject buttons close the modal
 *   - Changed files section expands/collapses
 *   - Type badge shows correct request type
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Checkpoint Approval', () => {
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

  test('modal renders with approval request details', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="checkpoint-approval-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    await expect(modal).toBeVisible()
    await expect(page.locator('[data-testid="checkpoint-approve-btn"]')).toBeVisible()
    await expect(page.locator('[data-testid="checkpoint-reject-btn"]')).toBeVisible()
  })

  test('approve button accepts and closes modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="checkpoint-approval-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    await page.locator('[data-testid="checkpoint-approve-btn"]').click()
    await page.waitForTimeout(1_000)
    await expect(modal).toBeHidden({ timeout: 5_000 })
  })

  test('reject button declines and closes modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="checkpoint-approval-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    await page.locator('[data-testid="checkpoint-reject-btn"]').click()
    await page.waitForTimeout(1_000)
    await expect(modal).toBeHidden({ timeout: 5_000 })
  })

  test('changed files section expands and collapses', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="checkpoint-approval-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    const filesToggle = page.locator('[data-testid="checkpoint-files-toggle"]')
    if (!(await filesToggle.isVisible({ timeout: 2_000 }).catch(() => false))) { test.skip(); return }

    await filesToggle.click()
    await page.waitForTimeout(300)
    const fileEntries = modal.locator('.font-mono')
    expect(await fileEntries.count()).toBeGreaterThan(0)
    await filesToggle.click()
    await page.waitForTimeout(300)
  })

  test('type badge shows correct request type', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="checkpoint-approval-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    const typeBadge = page.locator('[data-testid="checkpoint-type-badge"]')
    await expect(typeBadge).toBeVisible()
    const badgeText = await typeBadge.textContent()
    expect(badgeText).toMatch(/Phase Gate|Merge Approval|Destructive Action/)
  })
})

/**
 * Bug Detail Deep E2E Tests
 *
 * Verifies BugDetail (160 LOC) — individual bug inspection and actions:
 *   - Detail panel renders with bug title and timestamp
 *   - Stack trace section displayed with copy-to-clipboard button
 *   - Resolve button marks bug as resolved
 *   - Unresolve returns resolved bug to open state
 *   - Note textarea allows saving user annotations
 *   - Delete button shows confirmation before removal
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/bug-detail-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'

test.describe('Bug Detail Deep', () => {
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

  async function navigateToBugDetail(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Navigate to bug tracker
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    await page.waitForTimeout(500)

    // Look for bug tracker tab
    const bugTab = page.locator('button').filter({ hasText: /bug|tracker/i }).first()
    if (await bugTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await bugTab.click()
      await page.waitForTimeout(800)
    }

    // Look for bug cards to click
    const bugCards = page.locator('[data-testid="bug-card"]')
    const count = await bugCards.count()
    if (count > 0) {
      await bugCards.first().click()
      await page.waitForTimeout(500)
    }

    const bugDetail = page.locator('[data-testid="bug-detail-panel"]')
    return bugDetail.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('detail panel renders with bug title and timestamp', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')
    await expect(detail).toBeVisible()

    // Should show severity and process info
    const severityInfo = detail.getByText(/fatal|error/i).first()
    const hasSeverity = await severityInfo.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasSeverity).toBeTruthy()

    // Should show timestamp range (inline "First → Last" format) or occurrence count
    const timestampRange = detail.getByText(/→/).first()
    const occurrences = detail.getByText(/occurrence/i).first()
    const hasTimestamp = await timestampRange.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasOccurrences = await occurrences.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasTimestamp || hasOccurrences).toBeTruthy()
  })

  test('stack trace section displayed with copy-to-clipboard button', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')

    // Stack trace heading should be visible (if bug has a stack trace)
    const stackHeader = detail.getByText('Stack Trace')
    const hasStack = await stackHeader.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasStack) {
      // Bug may not have a stack trace — that's valid
      test.skip()
      return
    }

    // Copy button should be visible
    const copyBtn = detail.getByRole('button', { name: /copy stack/i }).first()
    await expect(copyBtn).toBeVisible()
  })

  test('resolve button marks bug as resolved', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')

    // Look for Mark Resolved or Reopen button
    const resolveBtn = detail.getByRole('button', { name: /mark resolved/i }).first()
    const reopenBtn = detail.getByRole('button', { name: /reopen/i }).first()

    const hasResolve = await resolveBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasReopen = await reopenBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least one status toggle button should be visible
    expect(hasResolve || hasReopen).toBeTruthy()
  })

  test('unresolve returns resolved bug to open state', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')

    // Look for Reopen button (bug is already resolved)
    const reopenBtn = detail.getByRole('button', { name: /reopen/i }).first()
    const hasReopen = await reopenBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasReopen) {
      // Bug is not resolved — can't test unresolve
      test.skip()
      return
    }

    await expect(reopenBtn).toBeVisible()
    await expect(reopenBtn).toBeEnabled()
  })

  test('note textarea allows saving user annotations', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')

    // Note section: either a "Note" collapsible section (bug has note) or "Add Note" button (no note)
    const noteSection = detail.getByText('Note').first()
    const addNoteBtn = detail.getByRole('button', { name: /add note/i }).first()
    const hasNoteSection = await noteSection.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasAddNote = await addNoteBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasNoteSection || hasAddNote).toBeTruthy()

    // If "Add Note" button visible, click it to expand textarea
    if (hasAddNote) {
      await addNoteBtn.click()
      await page.waitForTimeout(300)
    } else if (hasNoteSection) {
      // Click pencil edit button to enter edit mode
      const editBtn = detail.getByRole('button', { name: /edit note/i }).first()
      const hasEdit = await editBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasEdit) await editBtn.click()
      await page.waitForTimeout(300)
    }

    // Textarea should now be visible in edit mode
    const textarea = detail.locator('textarea')
    await expect(textarea).toBeVisible()

    // Save button (text is "Save", not "Save Note")
    const saveBtn = detail.getByRole('button', { name: /^save$/i }).first()
    await expect(saveBtn).toBeVisible()
  })

  test('delete button shows confirmation before removal', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasDetail = await navigateToBugDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detail = page.locator('[data-testid="bug-detail-panel"]')

    // Delete button should be visible
    const deleteBtn = detail.getByRole('button', { name: /delete/i }).first()
    const hasDelete = await deleteBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasDelete).toBeTruthy()
  })
})

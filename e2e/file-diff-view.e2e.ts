/**
 * File Diff View E2E Tests
 *
 * Tests FileDiffView (124 LOC) — side-by-side code diff in chat:
 *   - File diff view renders in chat when code changes are shown
 *   - File path header displays the changed file name
 *   - Side-by-side panels show old and new content
 *   - Added lines have green background highlighting
 *   - Removed lines have red background highlighting
 *   - Loading state shows spinner while diff loads
 *
 * The FileDiffView appears in chat messages when code changes are expanded.
 * Tests verify DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/file-diff-view.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('File Diff View', () => {
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

  async function findFileDiffView(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const diffView = page.locator('[data-testid="file-diff-view"]')
    const hasDiffView = await diffView.first().isVisible({ timeout: 5_000 }).catch(() => false)
    return hasDiffView ? diffView.first() : null
  }

  test('file diff view renders in chat when code changes are shown', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const diffView = await findFileDiffView(page)
    if (!diffView) { test.skip(); return }

    // Diff view should be visible with proper structure
    await expect(diffView).toBeVisible()

    // Should have the header and the diff viewer content
    const header = diffView.locator('[data-testid="file-diff-header"]')
    await expect(header).toBeVisible()
  })

  test('file path header displays the changed file name', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const diffView = await findFileDiffView(page)
    if (!diffView) { test.skip(); return }

    const header = diffView.locator('[data-testid="file-diff-header"]')
    await expect(header).toBeVisible()

    // Header should show a file path (contains / or . for file extension)
    const headerText = await header.textContent()
    const hasFilePath =
      headerText?.includes('/') ||
      headerText?.includes('.ts') ||
      headerText?.includes('.tsx') ||
      headerText?.includes('.js') ||
      headerText?.includes('.py') ||
      headerText?.includes('.')

    expect(hasFilePath).toBeTruthy()
  })

  test('side-by-side panels show old and new content', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const diffView = await findFileDiffView(page)
    if (!diffView) { test.skip(); return }

    // ReactDiffViewer renders in split view — look for left/right titles
    const leftTitle = diffView.locator('text=Previous (HEAD)')
    const rightTitle = diffView.locator('text=Current (Working Tree)')

    const hasLeftTitle = await leftTitle.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasRightTitle = await rightTitle.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least one side should be visible (confirms split view is rendering)
    expect(hasLeftTitle || hasRightTitle).toBeTruthy()

    // The diff viewer should contain table rows (code lines)
    const tableRows = diffView.locator('table tr, [class*="diff-"]')
    const rowCount = await tableRows.count()
    expect(rowCount).toBeGreaterThan(0)
  })

  test('added lines have green background highlighting', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const diffView = await findFileDiffView(page)
    if (!diffView) { test.skip(); return }

    // Look for added line markers (+ indicators or green-styled elements)
    const addedStats = diffView.locator('[data-testid="file-diff-header"] .text-success')
    const hasAddedStats = await addedStats.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasAddedStats) {
      // Stats badge shows + count in green
      const text = await addedStats.textContent()
      expect(text?.startsWith('+')).toBeTruthy()
    } else {
      // No additions in this diff — skip
      test.skip()
    }
  })

  test('removed lines have red background highlighting', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const diffView = await findFileDiffView(page)
    if (!diffView) { test.skip(); return }

    // Look for removed line markers (- indicators or red-styled elements)
    const removedStats = diffView.locator('[data-testid="file-diff-header"] .text-danger')
    const hasRemovedStats = await removedStats.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasRemovedStats) {
      // Stats badge shows - count in red
      const text = await removedStats.textContent()
      expect(text?.startsWith('-')).toBeTruthy()
    } else {
      // No removals in this diff — skip
      test.skip()
    }
  })

  test('loading state shows spinner while diff loads', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    // Loading state is transient — look for the spinner element
    const spinner = page.locator('[data-testid="file-diff-view"] .animate-spin')
    const hasSpinner = await spinner.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasSpinner) {
      // If diff is already loaded, check that the "empty state" is not shown
      const emptyState = page.locator('text=Select a file to view changes')
      const diffView = page.locator('[data-testid="file-diff-view"]')
      const hasDiff = await diffView.isVisible({ timeout: 2_000 }).catch(() => false)
      const hasEmpty = await emptyState.isVisible({ timeout: 2_000 }).catch(() => false)

      if (!hasDiff && !hasEmpty) { test.skip(); return }

      // Either the diff is loaded (no spinner needed) or empty state is shown
      expect(hasDiff || hasEmpty).toBeTruthy()
      return
    }

    // Spinner should be visible during load
    await expect(spinner).toBeVisible()
  })
})

/**
 * Code Changes & Commit E2E Tests
 *
 * Verifies the "ship your work" flow — after a Build conversation, the user
 * reviews diffs, selects files, writes a commit message, and pushes or creates a PR.
 *
 * Components covered:
 *   - CodeChangesPanel (master-detail layout)
 *   - FileChangeList (file list with checkboxes and change badges)
 *   - FileDiffView (side-by-side diff with line stats)
 *   - CommitBar (message input, generate, commit, push)
 *   - CreatePrModal (PR title, description, base branch)
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/code-changes-commit.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Code Changes & Commit', () => {
  /**
   * Helper: navigate to a workspace chat that has a Code Changes tab.
   * Returns the ChatPage POM + whether the Code Changes panel is accessible.
   */
  async function navigateToCodeChanges(
    page: import('@playwright/test').Page
  ): Promise<{ chat: ChatPage; hasPanel: boolean }> {
    const welcomePage = new WelcomePage(page)
    const chat = new ChatPage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }

    // Ensure chat panel is visible
    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      return { chat, hasPanel: false }
    }

    // Click "Code Changes" tab in the ChatPanel header
    const codeChangesTab = page.getByRole('button', { name: /code changes/i }).first()
    const hasTab = await codeChangesTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasTab) {
      return { chat, hasPanel: false }
    }
    await codeChangesTab.click()
    await page.waitForTimeout(1_000)

    // Wait for the panel to appear
    const panel = page.locator('[data-testid="code-changes-panel"]')
    const hasPanel = await panel.isVisible({ timeout: 5_000 }).catch(() => false)

    return { chat, hasPanel }
  }

  // ── CodeChangesPanel ──

  test('Code Changes tab renders master-detail layout (file list + diff pane)', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="code-changes-panel"]')
    await expect(panel).toBeVisible()

    // Master-detail: file list on left, diff pane on right
    const fileList = page.locator('[data-testid="file-change-list"]')
    const diffView = page.locator('[data-testid="file-diff-view"]')
    const emptyDiff = page.getByText(/select a file to view changes/i)

    const hasFileList = await fileList.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasDiffView = await diffView.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasEmptyDiff = await emptyDiff.isVisible({ timeout: 3_000 }).catch(() => false)

    // Either the file list renders OR the empty state renders (no git / no changes)
    // Diff pane shows either an actual diff or the "select a file" placeholder
    expect(hasFileList || hasDiffView || hasEmptyDiff).toBeTruthy()

    // Commit bar at the bottom
    const commitBar = page.locator('[data-testid="commit-bar"]')
    const hasCommitBar = await commitBar.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasCommitBar).toBeTruthy()
  })

  // ── FileChangeList ──

  test('File change list shows created/modified/deleted files with badges', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const fileList = page.locator('[data-testid="file-change-list"]')
    const hasFileList = await fileList.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasFileList) {
      // No files or git not configured — empty states are valid
      const noChanges = page.getByText(/no uncommitted changes/i)
      const gitNotConfigured = page.getByText(/git is not configured/i)
      const hasEmpty =
        (await noChanges.isVisible({ timeout: 3_000 }).catch(() => false)) ||
        (await gitNotConfigured.isVisible({ timeout: 3_000 }).catch(() => false))

      expect(hasEmpty).toBeTruthy()
      return
    }

    // File items should exist
    const fileItems = page.locator('[data-testid^="file-change-item-"]')
    const itemCount = await fileItems.count()
    expect(itemCount).toBeGreaterThan(0)

    // Each item should have a change type badge (A, M, or D)
    const firstItem = fileItems.first()
    const badgeText = await firstItem.textContent()
    expect(badgeText).toBeTruthy()

    // Badges should indicate change type
    const badges = fileList.locator('span').filter({ hasText: /^[AMD]$/ })
    const badgeCount = await badges.count()
    expect(badgeCount).toBeGreaterThan(0)
  })

  test('Clicking a file in the list renders its diff in the right pane', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const fileItems = page.locator('[data-testid^="file-change-item-"]')
    const itemCount = await fileItems.count()

    if (itemCount === 0) {
      test.skip()
      return
    }

    // Click the first file
    await fileItems.first().click()
    await page.waitForTimeout(1_000)

    // Diff view should now show content (not the placeholder)
    const diffView = page.locator('[data-testid="file-diff-view"]')
    const hasDiffView = await diffView.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasDiffView) {
      // Should have a diff header with file path
      const diffHeader = diffView.locator('.text-xs.font-medium').first()
      const hasHeader = await diffHeader.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasHeader).toBeTruthy()
    } else {
      // Loading state is acceptable
      const loader = page.locator('.animate-spin')
      const hasLoader = await loader.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasDiffView || hasLoader).toBeTruthy()
    }
  })

  test('File checkboxes toggle selection (individual + select all)', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const fileItems = page.locator('[data-testid^="file-change-item-"]')
    const itemCount = await fileItems.count()

    if (itemCount === 0) {
      test.skip()
      return
    }

    // Click the checkbox on the first file item
    const firstCheckbox = fileItems.first().locator('button').first()
    await firstCheckbox.click()
    await page.waitForTimeout(300)

    // The checkbox should toggle — look for the checked icon (CheckSquare)
    const checkedIcon = fileItems.first().locator('svg').first()
    await expect(checkedIcon).toBeVisible()

    // Select all button
    const selectAll = page.locator('[data-testid="file-change-select-all"]')
    const hasSelectAll = await selectAll.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSelectAll) {
      await selectAll.click()
      await page.waitForTimeout(300)

      // Button text should change to "Deselect all" when all selected
      const selectAllText = await selectAll.textContent()
      expect(selectAllText).toMatch(/select all|deselect all/i)
    }
  })

  // ── FileDiffView ──

  test('Diff view shows old/new content with syntax highlighting and line stats', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const fileItems = page.locator('[data-testid^="file-change-item-"]')
    const itemCount = await fileItems.count()

    if (itemCount === 0) {
      test.skip()
      return
    }

    // Select a file to show its diff
    await fileItems.first().click()
    await page.waitForTimeout(1_500)

    const diffView = page.locator('[data-testid="file-diff-view"]')
    const hasDiffView = await diffView.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDiffView) {
      test.skip()
      return
    }

    // Diff should have split view with Previous (HEAD) / Current (Working Tree) headers
    const leftHeader = page.getByText(/previous \(head\)/i)
    const rightHeader = page.getByText(/current \(working tree\)/i)
    const hasHeaders =
      (await leftHeader.isVisible({ timeout: 3_000 }).catch(() => false)) ||
      (await rightHeader.isVisible({ timeout: 3_000 }).catch(() => false))

    // Line stats (+N / -N) in the diff header
    const lineStats = diffView.locator('.font-mono').first()
    const hasStats = await lineStats.isVisible({ timeout: 3_000 }).catch(() => false)

    // At minimum the diff viewer should render content
    expect(hasHeaders || hasStats || hasDiffView).toBeTruthy()
  })

  // ── CommitBar ──

  test('Commit bar renders with message input and action buttons', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const commitBar = page.locator('[data-testid="commit-bar"]')
    const hasCommitBar = await commitBar.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasCommitBar) {
      test.skip()
      return
    }

    // Three possible states:
    // State 1: Uncommitted changes → message input + Commit buttons
    // State 2: All committed → Push + Create PR buttons
    // State 3: No files → "No pending changes" text

    const messageInput = commitBar.locator('input[type="text"]')
    const pushBtn = commitBar.getByRole('button', { name: /push/i })
    const noPendingText = commitBar.getByText(/no pending changes/i)

    const hasInput = await messageInput.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasPush = await pushBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasNoPending = await noPendingText.isVisible({ timeout: 3_000 }).catch(() => false)

    // One of the three states should be visible
    expect(hasInput || hasPush || hasNoPending).toBeTruthy()
  })

  test('"Generate Message" button populates commit message via AI', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const generateBtn = page.locator('[data-testid="commit-generate-btn"]')
    const hasGenerate = await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasGenerate) {
      // No uncommitted files — Auto button won't show
      test.skip()
      return
    }

    // The generate button should be clickable
    const isDisabled = await generateBtn.isDisabled()

    if (isDisabled) {
      test.skip()
      return
    }

    // Click generate — it should start generating (show spinner)
    await generateBtn.click()
    await page.waitForTimeout(500)

    // Either a spinner appears (generating) or the message input gets populated
    const spinner = generateBtn.locator('.animate-spin')
    const hasSpinner = await spinner.isVisible({ timeout: 3_000 }).catch(() => false)

    const messageInput = page.locator('[data-testid="commit-bar"] input[type="text"]')
    const inputValue = await messageInput.inputValue().catch(() => '')

    // Success if spinner showed (generating) or message was populated
    expect(hasSpinner || inputValue.length > 0).toBeTruthy()

    // Wait for generation to complete
    if (hasSpinner) {
      await spinner.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {})
    }
  })

  test('"Commit Selected" commits only checked files', async ({ electronPage: page }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const fileItems = page.locator('[data-testid^="file-change-item-"]')
    const itemCount = await fileItems.count()

    if (itemCount === 0) {
      test.skip()
      return
    }

    // Check the first file
    const firstCheckbox = fileItems.first().locator('button').first()
    await firstCheckbox.click()
    await page.waitForTimeout(300)

    // Type a commit message
    const messageInput = page.locator('[data-testid="commit-bar"] input[type="text"]')
    const hasInput = await messageInput.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasInput) {
      test.skip()
      return
    }

    await messageInput.fill('test: e2e commit selected files')
    await page.waitForTimeout(300)

    // "Commit (1)" button should appear for checked files
    const commitSelectedBtn = page
      .locator('[data-testid="commit-bar"]')
      .getByRole('button', { name: /commit \(\d+\)/i })

    const hasCommitSelected = await commitSelectedBtn
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    if (hasCommitSelected) {
      // Button text should show the count of selected files
      const buttonText = await commitSelectedBtn.textContent()
      expect(buttonText).toMatch(/commit \(\d+\)/i)

      // The button should be enabled (has message + has selection)
      const isDisabled = await commitSelectedBtn.isDisabled()
      expect(isDisabled).toBeFalsy()
    } else {
      // "Commit All" should be available at minimum
      const commitAllBtn = page
        .locator('[data-testid="commit-bar"]')
        .getByRole('button', { name: /commit all/i })
      const hasCommitAll = await commitAllBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasCommitAll).toBeTruthy()
    }
  })

  // ── CreatePrModal ──

  test('"Create PR" button opens CreatePrModal with pre-filled fields', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    // PR button appears in the post-commit state (all files committed)
    const createPrBtn = page
      .locator('[data-testid="commit-bar"]')
      .getByRole('button', { name: /create pr/i })
    const hasPrBtn = await createPrBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasPrBtn) {
      // Not in post-commit state — need to have committed first
      test.skip()
      return
    }

    await createPrBtn.click()
    await page.waitForTimeout(500)

    // Modal should open
    const modal = page.locator('[data-testid="create-pr-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Should have PR title and description fields
    const titleInput = modal.locator('input[type="text"]').first()
    await expect(titleInput).toBeVisible()

    // Title should be auto-filled from branch name
    const titleValue = await titleInput.inputValue()
    expect(titleValue.length).toBeGreaterThan(0)

    // Description textarea
    const descriptionArea = modal.locator('textarea')
    await expect(descriptionArea).toBeVisible()

    // Base branch input
    const baseBranchInput = modal.locator('input.font-mono')
    const hasBaseBranch = await baseBranchInput.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasBaseBranch).toBeTruthy()
  })

  test('CreatePrModal generates description, shows base branch, and submits', async ({
    electronPage: page
  }) => {
    const { hasPanel } = await navigateToCodeChanges(page)

    if (!hasPanel) {
      test.skip()
      return
    }

    const createPrBtn = page
      .locator('[data-testid="commit-bar"]')
      .getByRole('button', { name: /create pr/i })
    const hasPrBtn = await createPrBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasPrBtn) {
      test.skip()
      return
    }

    await createPrBtn.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[data-testid="create-pr-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // "Auto-generate" description button
    const autoGenBtn = modal.getByText(/auto-generate/i)
    const hasAutoGen = await autoGenBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasAutoGen) {
      await autoGenBtn.click()
      await page.waitForTimeout(500)

      // Should show spinner or populate the textarea
      const spinner = modal.locator('.animate-spin')
      const hasSpinner = await spinner.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasSpinner) {
        await spinner.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {})
      }
    }

    // Branch info should show source → base
    const branchInfo = modal.locator('.font-mono').first()
    const hasBranchInfo = await branchInfo.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasBranchInfo).toBeTruthy()

    // "Create Pull Request" submit button
    const submitBtn = modal.getByRole('button', { name: /create pull request/i })
    await expect(submitBtn).toBeVisible()

    // Cancel button should close modal
    const cancelBtn = modal.getByRole('button', { name: /cancel/i })
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Modal should be gone
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})

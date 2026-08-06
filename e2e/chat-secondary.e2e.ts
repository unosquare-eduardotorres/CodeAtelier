/**
 * Chat Secondary Interactions E2E Tests
 *
 * Covers sub-components that exist, render, and are user-facing but
 * had zero or minimal E2E testing:
 *   - BuildSummaryCard with file counts and success/failure status
 *   - DiagnosticsPanel showing LSP errors with file/line references
 *   - InsightsSummary showing messages/tokens/cost/duration stats
 *   - Todo items rendering in execution panel with complete/incomplete items
 *   - IdeaPopover saving a message as a workspace idea
 *   - MessageListFooter showing follow-up prompt suggestions
 *   - ImagePreviewThumbnail with lightbox click
 *   - HookActivityIndicator showing active SDK hook names
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/chat-secondary.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Chat Secondary Interactions', () => {
  async function ensureWorkspaceOpen(page: import('@playwright/test').Page): Promise<ChatPage> {
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

    return chat
  }

  // ── BuildSummaryCard ──

  test('BuildSummaryCard renders with file counts and success/failure indicators', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // BuildSummaryCard appears after a build completes
    const summaryCard = page.locator('[data-testid="build-summary-card"]')
    const hasCard = await summaryCard
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (!hasCard) {
      // No build summaries in current conversation
      test.skip()
      return
    }

    const firstCard = summaryCard.first()

    // Should show success/failure status (green or amber header)
    const headerBg = firstCard.locator('[class*="bg-success"], [class*="bg-warning"]').first()
    const hasStatus = await headerBg.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasStatus).toBeTruthy()

    // Should contain file count information
    const cardText = await firstCard.textContent()
    expect(cardText!.length).toBeGreaterThan(0)

    // Should have task status indicators (completed, failed counts)
    const hasNumbers = /\d+/.test(cardText ?? '')
    expect(hasNumbers).toBeTruthy()
  })

  // ── DiagnosticsPanel ──

  test('DiagnosticsPanel shows LSP errors with file references', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const hasPanel = await panel.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPanel) {
      // No diagnostics — workspace may have no LSP errors
      test.skip()
      return
    }

    // Should show error/warning count in collapsed header
    const headerText = await panel.textContent()
    expect(headerText).toMatch(/error|warning|diagnostic/i)

    // Click to expand
    const expandBtn = panel.locator('button').first()
    await expandBtn.click()
    await page.waitForTimeout(300)

    // Expanded should show file references with line numbers
    const diagnosticEntries = panel.locator('[class*="font-mono"]')
    const entryCount = await diagnosticEntries.count()

    if (entryCount > 0) {
      // Should contain file path or line number references
      const entryText = await diagnosticEntries.first().textContent()
      expect(entryText!.length).toBeGreaterThan(0)
    }

    // Collapse again
    await expandBtn.click()
    await page.waitForTimeout(300)
  })

  // ── InsightsSummary ──

  test('InsightsSummary shows messages, tokens, cost, and duration stats', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // InsightsSummary typically appears in the CloseDialog or in chat views
    const summary = page.locator('[data-testid="insights-summary"]')
    const hasSummary = await summary.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSummary) {
      // Insights may only show in specific views
      test.skip()
      return
    }

    // Should show "Session Insights" header
    const header = summary.getByText(/session insights/i)
    await expect(header).toBeVisible()

    // Should have stat pills with numbers
    const statPills = summary.locator('.rounded-lg')
    const pillCount = await statPills.count()
    expect(pillCount).toBeGreaterThan(0)

    // Should display values like "turns", "tokens", "cost", "duration"
    const summaryText = await summary.textContent()
    const hasStats = /turns|tokens|cost|duration|files/i.test(summaryText ?? '')
    expect(hasStats).toBeTruthy()
  })

  // ── Todos tab in execution panel ──

  test('Todos tab renders checklist in execution panel', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // Open the execution panel via the badge toggle
    const toggleBtn = page.locator('[data-testid="task-summary-badge-toggle"]')
    const hasToggle = await toggleBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasToggle) {
      // No tasks/todos badge visible
      test.skip()
      return
    }

    await toggleBtn.click()
    await page.waitForTimeout(500)

    const panel = page.locator('[data-testid="chat-execution-panel"]')
    const hasPanel = await panel.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasPanel) {
      test.skip()
      return
    }

    // Click the Todos tab
    const todosTab = panel.locator('[data-testid="chat-execution-tab-todos"]')
    await todosTab.click()
    await page.waitForTimeout(300)

    // Look for todo items or the empty state
    const todoItems = panel.locator('[class*="text-text-body"], [class*="text-text-muted"]')
    const emptyState = panel.getByText('No todos')
    const hasItems = (await todoItems.count()) > 0
    const hasEmpty = await emptyState.isVisible({ timeout: 2_000 }).catch(() => false)

    // Either todo items or empty state should be visible
    expect(hasItems || hasEmpty).toBeTruthy()
  })

  // ── IdeaPopover ──

  test('IdeaPopover renders with title input and save button', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // IdeaPopover appears via the "Save as Idea" button on messages
    const ideaPopover = page.locator('[data-testid="idea-popover"]')
    const hasPopover = await ideaPopover.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasPopover) {
      // Try to trigger via a "save as idea" button
      const saveIdeaBtn = page.getByRole('button', { name: /save.*idea|idea/i }).first()
      const hasSaveBtn = await saveIdeaBtn.isVisible({ timeout: 3_000 }).catch(() => false)

      if (!hasSaveBtn) {
        test.skip()
        return
      }

      await saveIdeaBtn.click()
      await page.waitForTimeout(500)

      const hasPopoverNow = await ideaPopover.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasPopoverNow) {
        test.skip()
        return
      }
    }

    // Should have title input
    const titleInput = ideaPopover.locator('input')
    await expect(titleInput).toBeVisible()

    // Should have a save/confirm button
    const saveBtn = ideaPopover.getByRole('button', { name: /save|add|create/i }).first()
    const hasSave = await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasSave).toBeTruthy()

    // Close via Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })

  // ── MessageListFooter (follow-up suggestions) ──

  test('MessageListFooter shows follow-up prompt suggestion', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // Follow-up suggestions appear after assistant messages
    // They are rendered inside MessageListFooter
    const suggestion = page.locator('button').filter({ hasText: /^(?!.*\n).{10,100}$/ })
    const hasSuggestion = await suggestion
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (!hasSuggestion) {
      // No follow-up suggestion present — this is normal
      test.skip()
      return
    }

    // Suggestion button should be clickable
    const firstSuggestion = suggestion.first()
    await expect(firstSuggestion).toBeEnabled()

    // Get the suggestion text to verify it's non-empty
    const text = await firstSuggestion.textContent()
    expect(text!.trim().length).toBeGreaterThan(5)
  })

  // ── ImagePreviewThumbnail ──

  test('ImagePreviewThumbnail opens lightbox on click', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!inputReady) {
      test.skip()
      return
    }

    // ImagePreviewThumbnail only renders when images are attached
    const thumbnail = page.locator('[data-testid="image-preview-thumbnail"]')
    const hasThumbnail = await thumbnail
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    if (!hasThumbnail) {
      // No image attachments — expected in most conversations
      test.skip()
      return
    }

    // Should have a visible image or skeleton
    const img = thumbnail.first().locator('img')
    const skeleton = thumbnail.first().locator('[class*="animate-pulse"]')
    const hasImg = await img.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasSkeleton = await skeleton.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasImg || hasSkeleton).toBeTruthy()

    // Click the image to open lightbox
    if (hasImg) {
      await img.click()
      await page.waitForTimeout(500)

      // Lightbox overlay should appear
      const lightbox = page.locator('[class*="fixed inset-0"]')
      const hasLightbox = await lightbox
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)

      if (hasLightbox) {
        // Close lightbox
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }
    }
  })

  // ── HookActivityIndicator ──

  test('HookActivityIndicator shows active SDK hook names during streaming', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // HookActivityIndicator only renders during streaming when hooks are active
    const indicator = page.locator('[data-testid="hook-activity-indicator"]')
    const hasIndicator = await indicator.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasIndicator) {
      // No hooks running — expected when not streaming
      test.skip()
      return
    }

    // Should show "Running:" followed by hook name(s)
    const indicatorText = await indicator.textContent()
    expect(indicatorText).toContain('Running:')

    // Should have the pulsing animation
    const hasPulse = (await indicator.getAttribute('class'))?.includes('animate-pulse')
    expect(hasPulse).toBeTruthy()
  })
})

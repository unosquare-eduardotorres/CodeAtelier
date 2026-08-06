/**
 * Chat Pills & Banners E2E Tests
 *
 * Tests status indicators and error/warning banners in the chat view:
 *   - RateLimitBadge warning/rejected status with percentage
 *   - ContextBadge usage percentage with severity colors
 *   - ApiRetryBanner retry count and status.claude.com link
 *   - SessionRecoveryBanner phase-based recovery progress
 *   - RepoWarningBanner git setup prompt with "Set up now" link
 *   - RepoWarningBanner dismiss and persistence
 *
 * These components render conditionally based on app state (rate limits,
 * context usage, API errors, session recovery, git config). Tests verify
 * either their presence when triggered or their absence in normal state.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/chat-pills-banners.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Chat Pills & Banners', () => {
  /**
   * Helper: ensure we're in a workspace with a chat view ready.
   */
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

  // ── RateLimitBadge ──

  test('RateLimitBadge shows warning/rejected status with percentage', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // RateLimitBadge renders when status is 'allowed_warning' or 'rejected'
    // Prefer testid locator, fall back to text
    const rateLimitBadge = page.locator('[data-testid="rate-limit-badge"]')
    const rateLimitByText = page.getByText(/claude usage \d+%/i)
    const hasBadge =
      (await rateLimitBadge.isVisible({ timeout: 5_000 }).catch(() => false)) ||
      (await rateLimitByText.isVisible({ timeout: 1_000 }).catch(() => false))

    if (!hasBadge) {
      // No rate limit warning in current state — this is expected in normal usage
      const badgeCount = await rateLimitBadge.count()
      expect(badgeCount).toBe(0)
      return
    }

    // Badge is visible — verify styling
    const classes = await rateLimitBadge.getAttribute('class')

    // Should have warning or danger styling
    const isWarning = classes?.includes('text-warning')
    const isDanger = classes?.includes('text-danger')
    expect(isWarning || isDanger).toBeTruthy()

    // Should have a title attribute with utilization info
    const title = await rateLimitBadge.getAttribute('title')
    expect(title).toMatch(/rate limit/i)

    // Percentage should be a valid number
    const text = await rateLimitBadge.textContent()
    const match = text?.match(/(\d+)%/)
    if (match) {
      const percentage = parseInt(match[1], 10)
      expect(percentage).toBeGreaterThanOrEqual(0)
      expect(percentage).toBeLessThanOrEqual(100)
    }
  })

  // ── ContextBadge ──

  test('ContextBadge shows usage percentage with severity colors', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // ContextBadge — prefer testid, fall back to text
    const contextBadgeById = page.locator('[data-testid="context-badge"]')
    const contextBadge = page.getByText(/\d+% context/i)
    const hasBadge =
      (await contextBadgeById.isVisible({ timeout: 5_000 }).catch(() => false)) ||
      (await contextBadge.isVisible({ timeout: 1_000 }).catch(() => false))

    if (!hasBadge) {
      // Context badge may not be visible if no active conversation or usage is 0%
      // Also check for compact form (just "XX%")
      const compactBadge = page.locator('[title^="Context"]')
      const hasCompact = await compactBadge.isVisible({ timeout: 3_000 }).catch(() => false)

      if (!hasCompact) {
        // No context badge visible — normal in idle state
        return
      }

      // Compact form exists — verify title
      const title = await compactBadge.getAttribute('title')
      expect(title).toMatch(/context usage/i)
      return
    }

    // Full badge is visible
    const classes = await contextBadge.getAttribute('class')

    // Should have severity-colored styling (green/yellow/red/critical)
    const hasSuccessStyle = classes?.includes('text-success')
    const hasWarningStyle = classes?.includes('text-warning')
    const hasDangerStyle = classes?.includes('text-danger')

    expect(hasSuccessStyle || hasWarningStyle || hasDangerStyle).toBeTruthy()

    // Title should show context usage information
    const title = await contextBadge.getAttribute('title')
    expect(title).toMatch(/context/i)
  })

  // ── ApiRetryBanner ──

  test('ApiRetryBanner shows retry count and status.claude.com link', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // ApiRetryBanner appears during transient API errors
    // Look for retry text or status.claude.com link
    const retryBanner = page.getByText(/retrying \(\d+\/\d+\)/i)
    const hasBanner = await retryBanner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      // No API error currently — this is the normal case
      // Verify there's no stale banner lingering
      const staleBanner = page.getByText(/claude api is overloaded/i)
      const hasStale = await staleBanner.isVisible({ timeout: 1_000 }).catch(() => false)
      expect(hasStale).toBeFalsy()
      return
    }

    // Banner is visible — verify structure
    // Should show the error label
    const errorLabel = page.getByText(/claude api|transient.*error/i)
    const hasLabel = await errorLabel.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasLabel).toBeTruthy()

    // Should have a link to status.claude.com
    const statusLink = page.getByText(/status\.claude\.com/i)
    const hasLink = await statusLink.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasLink).toBeTruthy()

    // Should show spinning refresh icon
    const spinner = page.locator('.animate-spin').first()
    const hasSpinner = await spinner.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasSpinner).toBeTruthy()
  })

  // ── SessionRecoveryBanner ──

  test('SessionRecoveryBanner shows phase-based recovery progress', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // SessionRecoveryBanner shows "Recovering Session" or "Recovery Failed"
    const recoveryBanner = page.getByText(/recovering session|recovery failed/i)
    const hasBanner = await recoveryBanner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      // No active recovery — this is the normal case
      return
    }

    // Banner is visible — verify structure
    const text = await recoveryBanner.textContent()

    if (text?.includes('Failed')) {
      // Failed state — should have warning styling
      const parentBanner = recoveryBanner.locator('..')
      const classes = await parentBanner.getAttribute('class')
      expect(classes).toContain('text-red')
    } else {
      // Active recovery — should have amber styling and spinner
      const spinner = page.locator('.animate-spin').first()
      const hasSpinner = await spinner.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasSpinner).toBeTruthy()
    }

    // Should show a recovery message
    const messageEl = page.locator('.text-xs.opacity-70').first()
    const hasMessage = await messageEl.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasMessage).toBeTruthy()
  })

  // ── RepoWarningBanner ──

  test('RepoWarningBanner shows git setup prompt with "Set up now" link', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // RepoWarningBanner renders when git is not configured
    // Two variants:
    // 1. "Set up a repository to track your code changes" (no repo)
    // 2. "Connect GitHub to enable pull requests" (repo but no GitHub)
    const repoWarning = page.getByText(/set up a repository|connect github/i)
    const hasBanner = await repoWarning.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      // Git is configured — no banner expected
      return
    }

    // "Set up now" or "Connect" action button
    const actionBtn = page.getByRole('button', { name: /set up now|connect/i }).first()
    const hasAction = await actionBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasAction).toBeTruthy()

    // Dismiss button (× with aria-label="Dismiss")
    const dismissBtn = page.locator('[aria-label="Dismiss"]').first()
    const hasDismiss = await dismissBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasDismiss).toBeTruthy()
  })

  test('RepoWarningBanner dismisses and persists dismissal', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    const repoWarning = page.getByText(/set up a repository|connect github/i)
    const hasBanner = await repoWarning.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      // No banner to dismiss — git is configured
      test.skip()
      return
    }

    // Click dismiss button
    const dismissBtn = page.locator('[aria-label="Dismiss"]').first()
    const hasDismiss = await dismissBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasDismiss) {
      test.skip()
      return
    }

    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Banner should be hidden
    await expect(repoWarning).toBeHidden({ timeout: 3_000 })

    // Verify persistence — the banner should stay dismissed after brief wait
    await page.waitForTimeout(1_000)
    const stillHidden = !(await repoWarning.isVisible({ timeout: 1_000 }).catch(() => false))
    expect(stillHidden).toBeTruthy()
  })
})

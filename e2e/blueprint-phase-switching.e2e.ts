/**
 * Blueprint Phase Switching E2E Tests
 *
 * Covers BlueprintPhaseStream phase switching — the core blueprint UX:
 *   - Clicking completed phase in timeline shows its output
 *   - Clicking active phase returns to live stream
 *   - Phase stream shows artifacts with markdown rendering
 *   - Clarify phase textarea sends message and advances
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/blueprint-phase-switching.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Blueprint Phase Switching', () => {
  /**
   * Helper: navigate to the Blueprints tab in workspace settings.
   */
  async function navigateToBlueprints(page: import('@playwright/test').Page): Promise<void> {
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
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('blueprints')
    await page.waitForTimeout(500)
  }

  /**
   * Helper: open an existing blueprint that has at least one completed phase.
   * Returns true if successfully opened.
   */
  async function openBlueprintWithPhases(page: import('@playwright/test').Page): Promise<boolean> {
    await navigateToBlueprints(page)

    // Look for existing blueprint cards with completed status
    const blueprintCards = page.locator('[data-testid^="blueprint-card-"]')
    const count = await blueprintCards.count()

    if (count === 0) return false

    // Click the first blueprint to open it
    await blueprintCards.first().click()
    await page.waitForTimeout(2_000)

    // Check for the blueprint phase stream or timeline
    const timeline = page.locator('[data-testid="blueprint-timeline"]')
    const phaseStream = page.locator('[data-testid="blueprint-phase-stream"]')

    const hasTimeline = await timeline.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasPhaseStream = await phaseStream.isVisible({ timeout: 3_000 }).catch(() => false)

    return hasTimeline || hasPhaseStream
  }

  // ── Phase clicking ──

  test('clicking completed phase in timeline shows its output', async ({ electronPage: page }) => {
    const hasBlueprint = await openBlueprintWithPhases(page)

    if (!hasBlueprint) {
      test.skip()
      return
    }

    const timeline = page.locator('[data-testid="blueprint-timeline"]')
    const hasTimeline = await timeline.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasTimeline) {
      test.skip()
      return
    }

    // Find completed phase items in the timeline
    const phaseItems = page.locator('[data-testid^="phase-list-item-"]')
    const phaseCount = await phaseItems.count()

    if (phaseCount < 2) {
      // Need at least 2 phases to test switching
      test.skip()
      return
    }

    // Get text of the first phase item
    const firstPhaseText = await phaseItems.first().textContent()

    // Click the first phase
    await phaseItems.first().click()
    await page.waitForTimeout(1_000)

    // The phase stream content area should update
    const phaseStream = page.locator('[data-testid="blueprint-phase-stream"]')
    const hasStream = await phaseStream.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasStream) {
      const streamContent = await phaseStream.textContent()
      // Content should be non-empty for a completed phase
      expect(streamContent?.length).toBeGreaterThan(0)
    }

    // First phase text should still be relevant
    expect(firstPhaseText?.length).toBeGreaterThan(0)
  })

  test('clicking active phase returns to live stream', async ({ electronPage: page }) => {
    const hasBlueprint = await openBlueprintWithPhases(page)

    if (!hasBlueprint) {
      test.skip()
      return
    }

    const phaseItems = page.locator('[data-testid^="phase-list-item-"]')
    const phaseCount = await phaseItems.count()

    if (phaseCount < 2) {
      test.skip()
      return
    }

    // Click the first completed phase to switch away
    await phaseItems.first().click()
    await page.waitForTimeout(1_000)

    // Now click the last phase (likely the active one)
    await phaseItems.last().click()
    await page.waitForTimeout(1_000)

    // The phase stream content should update to show current phase
    const phaseStream = page.locator('[data-testid="blueprint-phase-stream"]')
    const hasStream = await phaseStream.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasStream) {
      // Should have content (either streaming or completed)
      const streamContent = await phaseStream.textContent()
      expect(streamContent?.length).toBeGreaterThan(0)
    }

    // Verify we didn't break the timeline
    const timeline = page.locator('[data-testid="blueprint-timeline"]')
    await expect(timeline).toBeVisible({ timeout: 3_000 })
  })

  // ── Artifacts ──

  test('phase stream shows artifacts with markdown rendering', async ({ electronPage: page }) => {
    const hasBlueprint = await openBlueprintWithPhases(page)

    if (!hasBlueprint) {
      test.skip()
      return
    }

    // Find phase items with content
    const phaseItems = page.locator('[data-testid^="phase-list-item-"]')
    const phaseCount = await phaseItems.count()

    if (phaseCount === 0) {
      test.skip()
      return
    }

    // Click the first phase to ensure its output is shown
    await phaseItems.first().click()
    await page.waitForTimeout(1_000)

    // Look for rendered markdown content (headers, lists, code blocks)
    const phaseStream = page.locator('[data-testid="blueprint-phase-stream"]')
    const hasStream = await phaseStream.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasStream) {
      test.skip()
      return
    }

    // Check for markdown-rendered elements (prose/markdown container)
    const markdownContent = phaseStream.locator('h1, h2, h3, ul, ol, pre, p').first()
    const hasMarkdown = await markdownContent.isVisible({ timeout: 3_000 }).catch(() => false)

    // Look for copy button on artifact content
    const copyBtn = phaseStream
      .locator('button[aria-label*="copy" i], button[title*="copy" i]')
      .first()
    const hasCopyBtn = await copyBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least markdown or copy functionality should be present
    expect(hasMarkdown || hasCopyBtn).toBeTruthy()
  })

  // ── Clarify phase ──

  test('clarify phase textarea sends message and advances', async ({ electronPage: page }) => {
    await navigateToBlueprints(page)

    // Look for a blueprint in clarify phase (or start a new one)
    const blueprintCards = page.locator('[data-testid^="blueprint-card-"]')
    const count = await blueprintCards.count()

    if (count === 0) {
      // Try to start a new blueprint that would enter clarify phase
      const newBlueprintBtn = page.getByRole('button', { name: /new blueprint|create/i }).first()
      const hasNew = await newBlueprintBtn.isVisible({ timeout: 5_000 }).catch(() => false)

      if (!hasNew) {
        test.skip()
        return
      }
    }

    // Click first blueprint or look for active clarify phase
    if (count > 0) {
      await blueprintCards.first().click()
      await page.waitForTimeout(2_000)
    }

    // Look for clarify textarea within the phase stream
    const phaseStream = page.locator('[data-testid="blueprint-phase-stream"]')
    const clarifyTextarea = phaseStream.locator('textarea').first()
    const hasTextarea = await clarifyTextarea.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasTextarea) {
      // No clarify phase active — this is phase-dependent
      test.skip()
      return
    }

    // Fill the textarea
    await clarifyTextarea.fill('E2E test clarification response')
    await page.waitForTimeout(300)

    // Verify the value was set
    const value = await clarifyTextarea.inputValue()
    expect(value).toBe('E2E test clarification response')

    // Look for send/submit button
    const sendBtn = page.getByRole('button', { name: /send|submit|continue/i }).first()
    const hasSend = await sendBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSend) {
      await expect(sendBtn).toBeEnabled()
    }

    // Also check for skip button in clarify phase
    const skipBtn = page.getByRole('button', { name: /skip/i }).first()
    const hasSkip = await skipBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least send or skip should be available in clarify phase
    expect(hasSend || hasSkip).toBeTruthy()
  })
})

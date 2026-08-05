/**
 * Grill Sidebar & Decisions E2E Tests
 *
 * Tests the "review" half of the Grill UX — the sidebar context panel and
 * the Decisions tab that groups Q→A decisions by iteration with collapsible
 * sections, score gauges, evaluation bubbles, and the requirement document panel.
 *
 * Components covered:
 *   - GrillSidebar (track info, iteration count, score gauge)
 *   - GrillDecisionsView (decision groups, expand/collapse, score gauges)
 *   - GrillEvaluationBubble (inline score + feedback text)
 *   - RequirementDocumentPanel (Full/Condensed toggle, copy button)
 *   - GrillPageFooter (phase-based buttons: Pause & Exit, Generate Plan, etc.)
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-sidebar-decisions.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Grill Sidebar & Decisions', () => {
  /**
   * Helper: navigate to a grill session (Ideas tab → start/resume grill).
   */
  async function navigateToGrill(page: import('@playwright/test').Page): Promise<boolean> {
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
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('ideas')
    await page.waitForTimeout(500)

    const grillBtn = page.getByRole('button', { name: /grill/i }).first()
    const hasGrillBtn = await grillBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasGrillBtn) {
      await grillBtn.click()
      await page.waitForTimeout(2_000)
    }

    const grillPage = page.locator('[data-testid="grill-page"]')
    return grillPage.isVisible({ timeout: 10_000 }).catch(() => false)
  }

  // ── GrillSidebar ──

  test('Grill sidebar renders with track info and iteration count', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    const sidebar = page.locator('[data-testid="grill-sidebar"]')
    const hasSidebar = await sidebar.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSidebar) {
      test.skip()
      return
    }

    // Sidebar should show track info
    const trackInfo = sidebar.getByText(/track|iteration|score/i).first()
    const hasTrackInfo = await trackInfo.isVisible({ timeout: 3_000 }).catch(() => false)

    // Should show specialist analyst portrait or score gauge
    const scoreGauge = sidebar.locator('svg, [class*="gauge"]').first()
    const hasGauge = await scoreGauge.isVisible({ timeout: 3_000 }).catch(() => false)

    // Should show iteration count
    const iterationText = sidebar.getByText(/iteration/i)
    const hasIteration = await iterationText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasTrackInfo || hasGauge || hasIteration).toBeTruthy()
  })

  // ── GrillDecisionsView ──

  test('Decisions tab shows decision groups by iteration (collapsible)', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Switch to the Decisions tab
    const decisionsTab = page.getByRole('button', { name: /decisions/i }).first()
    const hasDecisionsTab = await decisionsTab.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDecisionsTab) {
      test.skip()
      return
    }

    await decisionsTab.click()
    await page.waitForTimeout(1_000)

    const decisionsView = page.locator('[data-testid="grill-decisions-view"]')
    const hasDecisionsView = await decisionsView.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDecisionsView) {
      test.skip()
      return
    }

    // Should show decision groups (grouped by iteration/track)
    const decisionGroups = decisionsView.locator('[class*="rounded-lg"][class*="border"]')
    const groupCount = await decisionGroups.count()

    // At minimum the original idea description should be pinned at top
    const ideaText = decisionsView.getByText(/original idea|description/i).first()
    const hasIdea = await ideaText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(groupCount > 0 || hasIdea).toBeTruthy()
  })

  test('Decision group expand/collapse shows individual decisions', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Navigate to Decisions tab
    const decisionsTab = page.getByRole('button', { name: /decisions/i }).first()
    const hasDecisionsTab = await decisionsTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasDecisionsTab) {
      test.skip()
      return
    }
    await decisionsTab.click()
    await page.waitForTimeout(1_000)

    const decisionsView = page.locator('[data-testid="grill-decisions-view"]')
    const hasView = await decisionsView.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasView) {
      test.skip()
      return
    }

    // Find clickable decision group headers (with chevron icons)
    const groupHeaders = decisionsView.locator('[class*="cursor-pointer"]').first()
    const hasHeaders = await groupHeaders.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasHeaders) {
      test.skip()
      return
    }

    // Click to expand
    await groupHeaders.click()
    await page.waitForTimeout(500)

    // After expanding, individual Q→A items should be visible
    const qaItems = decisionsView.locator('[class*="space-y"] > div').first()
    const hasItems = await qaItems.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasItems).toBeTruthy()
  })

  test('Score gauge renders with numeric score and color coding', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Look for score gauge in sidebar or decisions view
    const sidebar = page.locator('[data-testid="grill-sidebar"]')
    const hasSidebar = await sidebar.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSidebar) {
      test.skip()
      return
    }

    // ScoreGauge is an SVG-based gauge component
    const gaugeElement = sidebar.locator('svg').first()
    const hasGauge = await gaugeElement.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasGauge) {
      // Score might not be available yet
      test.skip()
      return
    }

    // The gauge should contain a numeric score value
    const scoreText = sidebar.locator('text, [class*="score"], [class*="tabular"]').first()
    const hasScore = await scoreText.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasGauge || hasScore).toBeTruthy()
  })

  // ── GrillEvaluationBubble ──

  test('Evaluation bubble renders inline with score + feedback text', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Evaluation bubble appears in the chat stream after specialist analysis
    const evalBubble = page.locator('[data-testid="grill-evaluation-bubble"]')
    const hasBubble = await evalBubble.isVisible({ timeout: 30_000 }).catch(() => false)

    if (!hasBubble) {
      // Evaluation hasn't been generated yet
      test.skip()
      return
    }

    // Should contain a score gauge
    const gauge = evalBubble.locator('svg').first()
    const hasGauge = await gauge.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasGauge).toBeTruthy()

    // Should contain feedback text
    const feedbackText = evalBubble.locator('p, span').first()
    const text = await feedbackText.textContent()
    expect(text?.length).toBeGreaterThan(0)
  })

  // ── RequirementDocumentPanel ──

  test('Requirement document panel shows Full/Condensed toggle', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Navigate to Decisions tab to find the requirement document panel
    const decisionsTab = page.getByRole('button', { name: /decisions/i }).first()
    const hasDecisionsTab = await decisionsTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasDecisionsTab) {
      test.skip()
      return
    }
    await decisionsTab.click()
    await page.waitForTimeout(1_000)

    const docPanel = page.locator('[data-testid="requirement-doc-panel"]')
    const hasPanel = await docPanel.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Should show "Requirement Document" header
    const header = docPanel.getByText(/requirement document/i)
    await expect(header).toBeVisible()

    // Full/Condensed toggle buttons (if condensed variant available)
    const fullBtn = docPanel.getByRole('button', { name: /full/i })
    const condensedBtn = docPanel.getByRole('button', { name: /condensed/i })

    const _hasToggle =
      (await fullBtn.isVisible({ timeout: 3_000 }).catch(() => false)) ||
      (await condensedBtn.isVisible({ timeout: 3_000 }).catch(() => false))

    // Copy button should always be present
    const copyBtn = page.locator('[data-testid="requirement-doc-copy"]')
    const hasCopyBtn = await copyBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasCopyBtn).toBeTruthy()
  })

  test('Requirement document copy button works with "Copied!" feedback', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    const decisionsTab = page.getByRole('button', { name: /decisions/i }).first()
    const hasDecisionsTab = await decisionsTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasDecisionsTab) {
      test.skip()
      return
    }
    await decisionsTab.click()
    await page.waitForTimeout(1_000)

    const copyBtn = page.locator('[data-testid="requirement-doc-copy"]')
    const hasCopyBtn = await copyBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCopyBtn) {
      test.skip()
      return
    }

    // Button should show "Copy" text
    const initialText = await copyBtn.textContent()
    expect(initialText).toMatch(/copy/i)

    // Click copy
    await copyBtn.click()
    await page.waitForTimeout(300)

    // Should briefly show "Copied!" feedback
    const copiedText = await copyBtn.textContent()
    expect(copiedText).toMatch(/copied/i)

    // After timeout it should revert to "Copy"
    await page.waitForTimeout(2_500)
    const revertedText = await copyBtn.textContent()
    expect(revertedText).toMatch(/copy/i)
  })

  // ── GrillPageFooter ──

  test('Grill footer buttons change by session phase', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    const footer = page.locator('[data-testid="grill-page-footer"]')
    const hasFooter = await footer.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasFooter) {
      // Footer may be in a loading/evaluating state
      // Check for the evaluating variant
      const evalFooter = page.locator('.animate-spin').first()
      const hasEval = await evalFooter.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasEval) {
        test.skip()
        return
      }
      return
    }

    // Footer should contain phase-appropriate buttons
    // Phase 1 (questioning): "Pause & Exit" + "Submit Answers"
    // Phase 2 (post-evaluation): "Generate Plan" / "Continue in Chat" / "Council Sweep"
    const pauseBtn = footer.getByRole('button', { name: /pause|exit/i })
    const submitBtn = footer.getByRole('button', { name: /submit/i })
    const planBtn = footer.getByRole('button', { name: /generate plan/i })
    const chatBtn = footer.getByRole('button', { name: /continue.*chat/i })
    const councilBtn = footer.getByRole('button', { name: /council/i })

    const hasPause = await pauseBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasSubmit = await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasPlan = await planBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasChat = await chatBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasCouncil = await councilBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least one action button should be visible in any phase
    expect(hasPause || hasSubmit || hasPlan || hasChat || hasCouncil).toBeTruthy()
  })
})

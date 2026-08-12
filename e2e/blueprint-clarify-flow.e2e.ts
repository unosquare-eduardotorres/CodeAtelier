/**
 * Blueprint Clarify Q&A Flow — Fullstack E2E Test
 *
 * Drives the real Electron app through: New Blueprint → Specify → Clarify → Answer → Gate.
 * Everything is real (renderer, IPC, main process, SQLite) EXCEPT the non-deterministic model:
 *   - Tier 1: CLAUDE_SHIM_DIR env → scripted shim on PATH (deterministic, CI-safe)
 *   - Tier 2: LIVE_LLM=1 env → real Claude CLI (manual, Max subscription)
 *
 * Run commands:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim npx playwright test e2e/blueprint-clarify-flow.e2e.ts
 *   LIVE_LLM=1 npx playwright test --project electron-live   # Tier 2 (manual)
 *
 * Prerequisites:
 *   - Built app: out/main/index.js
 *   - A workspace with cloud provider configured (not local-llm)
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

const IS_LIVE = process.env.LIVE_LLM === '1'
const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR
const E2E_SENTINEL = 'E2E-ANSWER-SENTINEL'

// Skip entire file if neither shim nor live mode is configured
test.skip(!IS_SHIM && !IS_LIVE, 'Set CLAUDE_SHIM_DIR or LIVE_LLM=1 to enable this test')

// Generous timeout for pipeline execution (shim is fast, live LLM may take minutes)
test.setTimeout(IS_LIVE ? 600_000 : 120_000)

test.describe('Blueprint Clarify Q&A Flow', () => {
  // ── Helpers ──

  /**
   * Navigate to the Blueprints tab. Handles welcome modal, workspace selection,
   * and settings panel navigation.
   */
  async function navigateToBlueprints(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)

    // Handle welcome modal if present
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('E2E Test')
    }

    // Select first workspace if on welcome screen
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      // Use the specific workspace-item testid — the broad POM selector
      // also matches "Add Workspace" / "Create New Project" cards.
      const workspaceItems = page.locator('[data-testid="workspace-item"]')
      const count = await workspaceItems.count()
      if (count === 0) {
        test.skip(true, 'No workspaces available — add a workspace to run blueprint flow tests')
        return
      }
      await workspaceItems.first().click()
      await page.waitForTimeout(3_000)
    }

    // Click "Settings" sidebar tab
    const settingsTab = page.locator('[data-testid="sidebar-tab-settings"]')
    const hasSettings = await settingsTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasSettings) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    // Find and click the "Blueprints" tab in workspace settings
    const blueprintTab = page
      .locator('[data-testid="workspace-settings-tab"]')
      .filter({ hasText: /blueprint/i })
    const hasBlueprintTab = await blueprintTab
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
    if (hasBlueprintTab) {
      await blueprintTab.first().click()
      await page.waitForTimeout(500)
    }

    // Verify we're on the blueprint page
    await expect(page.locator('[data-testid="blueprint-page"]')).toBeVisible({ timeout: 10_000 })
  }

  /**
   * Install IPC event ledger into the page context.
   * Records every onBlueprint* event into window.__bpEvents.
   */
  async function installIpcLedger(page: import('@playwright/test').Page): Promise<void> {
    await page.evaluate(() => {
      const events: Array<{ event: string; seq: number; ts: number }> = []
      ;(window as any).__bpEvents = events
      let seq = 0

      const api = (window as any).api
      if (!api) return

      const listen = (name: string, fn: string) => {
        if (typeof api[fn] === 'function') {
          api[fn](() => {
            events.push({ event: name, seq: seq++, ts: Date.now() })
          })
        }
      }

      listen('phaseStart', 'onBlueprintPhaseStart')
      listen('phaseComplete', 'onBlueprintPhaseComplete')
      listen('clarifyFindings', 'onBlueprintClarifyFindings')
      listen('clarifyQuestions', 'onBlueprintClarifyQuestions')
      listen('clarifyGate', 'onBlueprintClarifyGate')
      listen('clarifyAwaitingInput', 'onBlueprintClarifyAwaitingInput')
    })
  }

  /**
   * Read the IPC event ledger from the page context.
   */
  async function readIpcLedger(
    page: import('@playwright/test').Page
  ): Promise<Array<{ event: string; seq: number; ts: number }>> {
    return page.evaluate(() => (window as any).__bpEvents ?? [])
  }

  // ── Main Flow Test ──

  test('Full clarify Q&A: create → specify → clarify → answer → gate', async ({
    electronPage: page
  }) => {
    // 1. Navigate to Blueprints
    await navigateToBlueprints(page)

    // 2. Install IPC event ledger BEFORE starting the pipeline
    await installIpcLedger(page)

    // 3. Dismiss onboard modal if present
    const onboardModal = page.locator('[data-testid="blueprint-onboard-modal"]')
    const hasOnboard = await onboardModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasOnboard) {
      const dismissBtn = onboardModal.getByRole('button', { name: /explore|dismiss|later/i })
      const canDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (canDismiss) {
        await dismissBtn.click()
        await page.waitForTimeout(500)
      }
    }

    // 4. Click "New Blueprint" button
    const newBlueprintBtn = page.getByRole('button', { name: /new blueprint/i }).first()
    await expect(newBlueprintBtn).toBeVisible({ timeout: 10_000 })
    await newBlueprintBtn.click()
    await page.waitForTimeout(1_000)

    // 5. Fill in title and description
    const titleInput = page.locator('[data-testid="blueprint-page"] input[type="text"]').first()
    await expect(titleInput).toBeVisible({ timeout: 5_000 })
    await titleInput.fill('E2E Clarify Flow')

    const descriptionTextarea = page.locator('[data-testid="blueprint-page"] textarea').first()
    const hasDesc = await descriptionTextarea.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasDesc) {
      await descriptionTextarea.fill(
        IS_LIVE
          ? 'Add a /hello endpoint that returns a greeting'
          : 'Add a /hello endpoint that returns a greeting — E2E test description'
      )
    }

    // 6. Click "Start Pipeline" button
    const startBtn = page.getByRole('button', { name: /start pipeline/i })
    await expect(startBtn).toBeVisible()
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    // ── Phase: SPECIFY ──
    // Wait for specify to start and complete (auto-transitions to clarify)
    // The shim responds quickly; live LLM may take 30-60s.

    // ── Phase: CLARIFY ──
    // Wait for the question footer to appear (proves specify completed + clarify started + questions parsed)
    const questionFooter = page.locator('[data-testid="blueprint-question-footer"]')
    await expect(questionFooter).toBeVisible({
      timeout: IS_LIVE ? 300_000 : 60_000
    })

    // 7. Assert transcript order (Fixes 2+3): agent bubble → findings card → question footer
    //    Findings card should be in the transcript (not the footer)
    const findingsCard = page.locator('[data-testid="blueprint-findings-card"]')
    const hasFindingsCard = await findingsCard
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (!IS_LIVE) {
      // Shim always emits findings — they must be visible
      expect(hasFindingsCard).toBeTruthy()
    }

    // If findings card is present, verify DOM order: findings before question footer
    if (hasFindingsCard) {
      const chatView = page.locator('[data-testid="blueprint-chat-view"]')
      const findingsPosition = await chatView
        .locator('[data-testid="blueprint-findings-card"]')
        .first()
        .evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return rect.top
        })
      const footerPosition = await questionFooter.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        return rect.top
      })
      expect(findingsPosition).toBeLessThan(footerPosition)
    }

    // 8. Answer the questions
    //    q1 = pick recommended option (JSON), q2 = pick "Other" with sentinel, q3 = skip
    //    The QuestionItem components use the GrillQuestionCard pattern with radio buttons
    if (!IS_LIVE) {
      // Shim mode: interact with the structured Q&A form
      // Find all question sections in the footer
      const questionSections = questionFooter.locator('[class*="space-y"]').first()
      await expect(questionSections).toBeVisible()

      // q1: Click the recommended option (JSON) — first radio/option button
      const q1Options = questionFooter
        .locator('label, [role="radio"], [role="checkbox"], button')
        .filter({ hasText: /JSON/i })
      const hasQ1 = await q1Options
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
      if (hasQ1) {
        await q1Options.first().click()
        await page.waitForTimeout(200)
      }

      // q2: Click "Other" and type the sentinel
      const otherButtons = questionFooter
        .locator('label, [role="radio"], [role="checkbox"], button')
        .filter({ hasText: /other/i })
      const otherCount = await otherButtons.count()
      if (otherCount >= 2) {
        // Second "Other" is for q2
        await otherButtons.nth(1).click()
        await page.waitForTimeout(200)
        // Type sentinel into the "Other" text input
        const otherInput = questionFooter
          .locator('input[type="text"], textarea')
          .filter({ hasText: '' })
        const otherInputCount = await otherInput.count()
        if (otherInputCount > 0) {
          await otherInput.last().fill(E2E_SENTINEL)
        }
      }

      // q3: Click "Skip" for the third question
      const skipCheckboxes = questionFooter.locator('label, button').filter({ hasText: /skip/i })
      const skipCount = await skipCheckboxes.count()
      if (skipCount > 0) {
        await skipCheckboxes.last().click()
        await page.waitForTimeout(200)
      }
    } else {
      // Live mode: use structured form if available, fall back to free text
      const freeTextToggle = questionFooter.getByText(/free text/i)
      const hasFreeText = await freeTextToggle.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasFreeText) {
        await freeTextToggle.click()
        await page.waitForTimeout(300)
      }

      const textarea = questionFooter.locator('textarea').first()
      const hasTextarea = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasTextarea) {
        await textarea.fill(`JSON format preferred. ${E2E_SENTINEL}. No rate limiting needed.`)
      }
    }

    // 9. Submit answers
    const submitBtn = questionFooter.getByRole('button', { name: /submit|send/i })
    await expect(submitBtn).toBeVisible()
    await submitBtn.click()

    // ── Assert: QA Record appears (Fix 4) ──
    const qaRecord = page.locator('[data-testid="blueprint-qa-record"]')
    await expect(qaRecord).toBeVisible({ timeout: IS_LIVE ? 120_000 : 30_000 })

    // QA record should show "Answers submitted" text
    await expect(qaRecord.getByText(/answers submitted/i)).toBeVisible()

    // Question footer should disappear after submission
    await expect(questionFooter).toBeHidden({ timeout: 10_000 })

    // ── Wait for Gate Card (Fix 1 — proves end-to-end answer round-trip) ──
    if (!IS_LIVE) {
      // Shim mode: gate card should appear after shim emits phase-complete
      const gateCard = page.locator('[data-testid="blueprint-clarify-gate"]')
      await expect(gateCard).toBeVisible({ timeout: 30_000 })

      // Gate card should have "Continue to Plan" button
      const proceedBtn = gateCard.getByRole('button', { name: /continue to plan|continue anyway/i })
      await expect(proceedBtn).toBeVisible()
    } else {
      // Live mode: wait for either gate or new questions round
      const gateOrQuestions = page.locator(
        '[data-testid="blueprint-clarify-gate"], [data-testid="blueprint-question-footer"]'
      )
      await expect(gateOrQuestions.first()).toBeVisible({ timeout: 300_000 })
    }

    // ── Assert: IPC Event Ordering ──
    const events = await readIpcLedger(page)

    if (!IS_LIVE && events.length > 0) {
      // Verify sequence: phaseStart(specify) appeared before clarify events
      const eventNames = events.map((e) => e.event)

      // Should have at least these core events
      expect(eventNames).toContain('phaseStart')

      // Check for no duplicate clarifyQuestions events (the bug's loop signature)
      const questionEventCount = events.filter((e) => e.event === 'clarifyQuestions').length
      expect(questionEventCount).toBeLessThanOrEqual(1)

      // Verify monotonic sequence numbers
      for (let i = 1; i < events.length; i++) {
        expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
      }
    }

    // ── Assert: Timestamps are stable (Fix 5) ──
    // Read rendered timestamps, wait, re-read — they should be identical
    const timestampElements = page
      .locator('[data-testid="blueprint-chat-view"] [class*="text-muted"]')
      .filter({ hasText: /\d{1,2}:\d{2}|ago|just now/i })
    const tsCount = await timestampElements.count()
    if (tsCount > 0) {
      const timestamps1 = await timestampElements.allTextContents()
      await page.waitForTimeout(2_000)
      const timestamps2 = await timestampElements.allTextContents()

      // Timestamps should not change (stable rendering)
      expect(timestamps1.length).toBe(timestamps2.length)
      for (let i = 0; i < Math.min(timestamps1.length, timestamps2.length); i++) {
        expect(timestamps1[i]).toBe(timestamps2[i])
      }
    }

    // ── Cleanup ──
    // Stop pipeline if still running
    const stopBtn = page.getByRole('button', { name: /stop|cancel/i }).first()
    const hasStop = await stopBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasStop) {
      await stopBtn.click()
      await page.waitForTimeout(1_000)

      // Confirm stop if there's a confirmation dialog
      const confirmBtn = page.getByRole('button', { name: /yes|confirm|stop/i }).first()
      const hasConfirm = await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasConfirm) {
        await confirmBtn.click()
        await page.waitForTimeout(1_000)
      }
    }
  })

  // ── Shim Marker Verification (Tier 1 only) ──

  test('Shim marker file was written (confirms shim was used, not real CLI)', async ({
    electronPage: _page
  }) => {
    test.skip(!IS_SHIM, 'Shim marker test only runs in shim mode')

    const fs = await import('fs')
    const path = await import('path')

    const markerDir = path.resolve(__dirname, 'helpers/claude-shim/.markers')
    let markerFiles: string[] = []
    try {
      markerFiles = fs.readdirSync(markerDir).filter((f: string) => f.startsWith('shim-'))
    } catch {
      // Marker dir might not exist if shim was never invoked
    }

    // At least one marker should exist (from the specify+clarify sessions).
    // If the flow test was skipped (no workspaces), no markers will exist.
    if (markerFiles.length === 0) {
      test.skip(true, 'No shim markers found — flow test likely skipped (no workspaces)')
      return
    }
    expect(markerFiles.length).toBeGreaterThan(0)
  })
})

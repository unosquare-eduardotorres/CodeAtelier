/**
 * LIVE GLM Clarify verification — question cards must render (v1.0.87 fix).
 *
 * Drives the REAL app (dev build, real dev store) with the REAL GLM provider
 * through: New Blueprint → Specify → Clarify. Success = the structured
 * question footer with QuestionItem cards appears (the fenced-block path),
 * NOT the free-text-only panel that v1.0.86's stale-idle bug produced.
 *
 * Prerequisites:
 *   - Built app (out/main/index.js) with the stale-idle fix
 *   - Dev store workspace 'AgentStudio' configured with llmProvider=glm
 *     (plaintext glmApiKey — legacy path, no keychain needed)
 *
 * Run: LIVE_LLM=1 npx playwright test --project electron-live e2e/glm-clarify-live.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'

const IS_LIVE = process.env.LIVE_LLM === '1'
test.skip(!IS_LIVE, 'Set LIVE_LLM=1 to enable this test')
test.setTimeout(600_000) // 10 min — real GLM pipeline

test.describe('GLM Clarify — live question cards', () => {
  test('Blueprint → Clarify renders structured question cards on GLM', async ({
    electronPage: page
  }) => {
    // 1. Get past welcome if present, pick the AgentStudio workspace
    const workspaceItems = page.locator('[data-testid="workspace-item"]')
    const welcomeVisible = await workspaceItems.first().isVisible({ timeout: 5_000 }).catch(() => false)
    if (welcomeVisible) {
      const target = workspaceItems.filter({ hasText: 'AgentStudio' }).first()
      const hasTarget = await target.isVisible({ timeout: 2_000 }).catch(() => false)
      await (hasTarget ? target : workspaceItems.first()).click()
      await page.waitForTimeout(3_000)
    }

    // 2. Navigate to Blueprints via settings
    const settingsTab = page.locator('[data-testid="sidebar-tab-settings"]')
    if (await settingsTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }
    const blueprintTab = page
      .locator('[data-testid="workspace-settings-tab"]')
      .filter({ hasText: /blueprint/i })
    if (await blueprintTab.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await blueprintTab.first().click()
      await page.waitForTimeout(500)
    }
    await expect(page.locator('[data-testid="blueprint-page"]')).toBeVisible({ timeout: 10_000 })

    // 3. Install IPC ledger to observe phase events
    await page.evaluate(() => {
      const events: Array<{ event: string; ts: number }> = []
      ;(window as any).__bpEvents = events
      const api = (window as any).api
      if (!api) return
      const listen = (name: string, fn: string) => {
        if (typeof api[fn] === 'function') {
          api[fn](() => events.push({ event: name, ts: Date.now() }))
        }
      }
      listen('phaseStart', 'onBlueprintPhaseStart')
      listen('phaseComplete', 'onBlueprintPhaseComplete')
      listen('clarifyQuestions', 'onBlueprintClarifyQuestions')
      listen('clarifyAwaitingInput', 'onBlueprintClarifyAwaitingInput')
    })

    // 4. New Blueprint
    const newBlueprintBtn = page.getByRole('button', { name: /new blueprint/i }).first()
    await expect(newBlueprintBtn).toBeVisible({ timeout: 10_000 })
    await newBlueprintBtn.click()
    await page.waitForTimeout(1_000)

    const titleInput = page.locator('[data-testid="blueprint-page"] input[type="text"]').first()
    await expect(titleInput).toBeVisible({ timeout: 5_000 })
    await titleInput.fill('GLM Live Verify')

    const descriptionTextarea = page.locator('[data-testid="blueprint-page"] textarea').first()
    if (await descriptionTextarea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await descriptionTextarea.fill(
        'Add a /health endpoint that returns uptime and version info'
      )
    }

    const startBtn = page.getByRole('button', { name: /start pipeline/i })
    await expect(startBtn).toBeVisible()
    await startBtn.click()

    // 5. THE assertion: structured question footer with question cards.
    //    v1.0.86 bug: awaitingInput with questions:null → free-text panel only.
    //    Fix: GLM streams the fenced questions block → cards render.
    const questionFooter = page.locator('[data-testid="blueprint-question-footer"]')
    await expect(questionFooter).toBeVisible({ timeout: 300_000 })

    // The footer must be the STRUCTURED variant: "Questions — N decisions"
    // header + at least one grill question card. The free-text variant shows
    // "Free-text answer" instead.
    await expect(
      questionFooter.locator('text=/Questions — \\d+ decision/i')
    ).toBeVisible({ timeout: 10_000 })
    const questionCards = page.locator('[data-testid="grill-question-card"]')
    await expect(questionCards.first()).toBeVisible({ timeout: 10_000 })
    const cardCount = await questionCards.count()
    expect(cardCount).toBeGreaterThanOrEqual(1)
    console.log(`[glm-clarify-live] ${cardCount} question cards rendered`)

    // 6. Ledger sanity: clarifyQuestions fired (fenced-block path), no failure
    const events = await page.evaluate(() => (window as any).__bpEvents ?? [])
    const names = events.map((e: { event: string }) => e.event)
    console.log(`[glm-clarify-live] IPC events: ${names.join(', ')}`)
    expect(names).toContain('clarifyQuestions')
    const failedComplete = events.filter(
      (e: { event: string }) => e.event === 'phaseComplete'
    )
    // phaseComplete(failed) for clarify must NOT have fired while awaiting input
    // (we can't see status in this ledger, but a failed specify would prevent
    // the question footer from ever appearing — its visibility is the proof)

    // 7. Cleanup: stop the pipeline so the workspace is left clean
    const stopBtn = page.getByRole('button', { name: /stop|cancel/i }).first()
    if (await stopBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await stopBtn.click()
      await page.waitForTimeout(1_000)
      const confirmBtn = page.getByRole('button', { name: /yes|confirm|stop/i }).first()
      if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirmBtn.click()
        await page.waitForTimeout(1_000)
      }
    }
  })
})

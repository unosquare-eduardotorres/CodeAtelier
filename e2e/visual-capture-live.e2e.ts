/**
 * visual-capture — screenshots EVERY page of the running app (real profile,
 * real demo data) into .impeccable/screenshots/<date>/ for the impeccable
 * visual audit. No assertions beyond "the page appeared" — this is capture,
 * not testing.
 *
 * Run: npx playwright test e2e/visual-capture.e2e.ts --project electron-live
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { test, expect } from './helpers/electron-fixture'

const OUT = join(process.cwd(), '.impeccable', 'screenshots', new Date().toISOString().slice(0, 10))

const TABS = [
  'health', 'design', 'council', 'ideas', 'blueprints', 'jira', 'testing',
  'specialist', 'team', 'models', 'repository', 'tracks', 'memory',
  'code-intelligence', 'integrations'
]

test('capture every page', async ({ page }) => {
  test.setTimeout(8 * 60_000)
  mkdirSync(OUT, { recursive: true })

  // BOOT DIAGNOSTIC — capture whatever exists before any waiting.
  await page.waitForTimeout(8_000)
  await page.screenshot({ path: join(OUT, '00-boot.png') })

  // Wait for the app shell (no preload calls needed — pure UI capture).
  await expect(page.locator('[data-testid="unified-sidebar"]').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: join(OUT, '00-chats.png'), fullPage: false })

  // Welcome / home screen
  const homeBtn = page.locator('[data-testid="nav-home"], button[title*="Home" i]').first()
  if (await homeBtn.count() > 0) {
    await homeBtn.click().catch(() => undefined)
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: join(OUT, '01-welcome.png') })
    // Re-enter the workspace via the first card
    const card = page.locator('[data-testid="workspace-card"]').first()
    if (await card.count() > 0) {
      await card.click().catch(() => undefined)
      await expect(page.locator('[data-testid="unified-sidebar"]').first()).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(1_000)
    }
  }

  // New chat form (⌘N equivalent — via the Chats tab new-chat affordance)
  const newChat = page.locator('[data-testid="new-chat-btn"], [title*="New chat" i]').first()
  if (await newChat.count() > 0) {
    await newChat.click().catch(() => undefined)
    await page.waitForTimeout(1_200)
    await page.screenshot({ path: join(OUT, '02-new-chat.png') })
  }

  // Every workspace tab
  let i = 10
  for (const tab of TABS) {
    const btn = page.locator(`[data-testid="workspace-settings-tab"][data-tab-id="${tab}"]`).first()
    if (await btn.count() === 0) continue
    await btn.click().catch(() => undefined)
    await page.waitForTimeout(1_800)
    await page.screenshot({ path: join(OUT, `${i}-${tab}.png`) })
    i++
  }

  // A blueprint detail (first history row) if present
  await page.locator('[data-testid="workspace-settings-tab"][data-tab-id="blueprints"]').first().click().catch(() => undefined)
  await page.waitForTimeout(1_200)
  const firstRun = page.locator('[data-testid="blueprint-run-card"], [data-testid="blueprint-history-item"]').first()
  if (await firstRun.count() > 0) {
    await firstRun.click().catch(() => undefined)
    await page.waitForTimeout(2_000)
    await page.screenshot({ path: join(OUT, '90-blueprint-detail.png'), fullPage: false })
  }
})

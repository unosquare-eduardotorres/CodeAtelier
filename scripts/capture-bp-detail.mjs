import { chromium } from 'playwright'
import { join } from 'path'
const OUT = join(process.cwd(), '.impeccable', 'screenshots', '2026-09-10')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 15_000 })
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'))
await page.bringToFront()
const tab = page.locator('[data-testid="workspace-settings-tab"][data-tab-id="blueprints"]').first()
await tab.waitFor({ state: 'visible', timeout: 10_000 })
await tab.click()
await page.waitForTimeout(2_500)
const candidates = ['[data-testid="blueprint-run-card"]', '[data-testid="design-run-card"]', '[data-testid*="blueprint"] button', '[data-testid*="blueprint"] a']
for (const sel of candidates) {
  const n = await page.locator(sel).count()
  console.log(sel, '→', n)
  if (n > 0) {
    await page.locator(sel).first().click().catch((e) => console.log('click err:', e.message.slice(0, 80)))
    await page.waitForTimeout(3_000)
    await page.screenshot({ path: join(OUT, '90-blueprint-detail.png') })
    console.log('CAPTURED detail')
    break
  }
}
await browser.close()

/** Visual capture — drives the RUNNING app over CDP (no test fixture).
 *  1) npx electron out/main/index.js --remote-debugging-port=9333 &
 *  2) node scripts/capture-screenshots.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'

const OUT = join(process.cwd(), '.impeccable', 'screenshots', new Date().toISOString().slice(0, 10))
mkdirSync(OUT, { recursive: true })
const TABS = ['health','design','council','ideas','blueprints','jira','testing','specialist','team','models','repository','tracks','memory','code-intelligence','integrations']

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 15_000 })
const ctx = browser.contexts().find((c) => c.pages().some((p) => p.url().includes('index.html')))
const page = ctx.pages().find((p) => p.url().includes('index.html'))
if (!page) { console.error('No app page found. Pages:', browser.contexts().flatMap(c=>c.pages().map(p=>p.url()))); process.exit(1) }
await page.bringToFront()
await page.waitForTimeout(2_000)

const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); console.log('✓', name) }
const click = async (sel, t = 6_000) => { const el = page.locator(sel).first(); await el.waitFor({ state: 'visible', timeout: t }).catch(() => null); await el.click().catch(() => null); await page.waitForTimeout(1_800) }

// 1. Whatever state the app restored into (chat/workspace home)
await shot('00-app-home')

// 2. Welcome screen (Home button), then back into first workspace
await click('[data-testid="nav-home"], button[title*="Home" i]')
await shot('01-welcome')
await click('[data-testid="workspace-card"]')
await page.waitForSelector('[data-testid="unified-sidebar"]', { timeout: 20_000 }).catch(() => null)
await page.waitForTimeout(1_500)

// 3. New chat form
await click('[data-testid="new-chat-btn"], [title*="New chat" i], [title*="New Chat" i]')
await shot('02-new-chat')

// 4. Every workspace tab
// The settings tabs only exist once the sidebar is on the Workspace tab.
await click('[data-testid="sidebar-tab-settings"]')
await page.waitForTimeout(1_500)
for (const tab of TABS) {
  await click(`[data-testid="workspace-settings-tab"][data-tab-id="${tab}"]`)
  await shot(`10-${tab}`)
}

// 5. Blueprint detail (first history item) + a design run view if one exists
await click('[data-testid="workspace-settings-tab"][data-tab-id="blueprints"]')
const run = page.locator('[data-testid="blueprint-run-card"], [data-testid="blueprint-history-item"], [data-testid="design-run-card"]').first()
if (await run.count() > 0) { await run.click().catch(() => null); await page.waitForTimeout(2_500); await shot('90-blueprint-detail') }

console.log('DONE →', OUT)
await browser.close()

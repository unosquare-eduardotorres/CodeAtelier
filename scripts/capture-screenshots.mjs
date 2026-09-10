/** Visual capture — drives the RUNNING app over CDP (no test fixture).
 *  1) npx electron out/main/index.js --remote-debugging-port=9333 &
 *  2) node scripts/capture-screenshots.mjs
 *
 * Tab navigation ports e2e/pages/settings-nav.ts (proven): click the sidebar
 * Workspace tab, then click the nav button BY LABEL TEXT, then ASSERT the
 * button is active (bg-primary-muted) before shooting — no swallow-all.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'

const OUT = join(process.cwd(), '.impeccable', 'screenshots', new Date().toISOString().slice(0, 10))
mkdirSync(OUT, { recursive: true })

const TABS = {
  health: 'Audit Code', design: 'Audit Design', council: 'Council', ideas: 'Ideas',
  blueprints: 'Blueprints', jira: 'Jira', testing: 'LLM Testing', specialist: 'Specialist',
  team: 'Team', models: 'Models', repository: 'Repository', tracks: 'Tracks',
  memory: 'Brain', 'code-intelligence': 'Code Intelligence', integrations: 'Integrations'
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 15_000 })
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'))
if (!page) { console.error('No app page'); process.exit(1) }
await page.bringToFront()
await page.waitForTimeout(2_500)

const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.png') }); console.log('✓', name) }

// Open the sidebar Workspace tab (settings panel) — proven POM step 1.
const sidebarTab = page.locator('[data-testid="sidebar-tab-settings"]')
await sidebarTab.waitFor({ state: 'visible', timeout: 10_000 })
await sidebarTab.click()
await page.waitForTimeout(1_000)

let failures = 0
for (const [tab, label] of Object.entries(TABS)) {
  // POM step 2: nav button matched by anchored label text.
  const btn = page.locator('nav button').filter({ hasText: new RegExp(`^${label}$`, 'i') }).first()
  const visible = await btn.isVisible({ timeout: 4_000 }).catch(() => false)
  if (!visible) { console.log(`✗ ${tab}: nav button "${label}" not found`); failures++; await shot(`90-FAIL-${tab}`); continue }
  await btn.click()
  await page.waitForTimeout(1_600)
  // Assert ACTIVE state — the clicked tab must carry the active class.
  const cls = (await btn.getAttribute('class')) ?? ''
  const active = cls.includes('bg-primary-muted')
  if (!active) { console.log(`✗ ${tab}: clicked but not active (class=${cls.slice(0, 80)})`); failures++; }
  await shot(`10-${tab}`)
}
console.log(failures === 0 ? 'ALL TABS NAVIGATED' : `${failures} tab(s) FAILED`)
await browser.close()

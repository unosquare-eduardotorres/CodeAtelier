/**
 * design-audit-live — P7.4, the live gate: one REAL design audit end to end.
 *
 * Exercises the full machinery no stub can prove: skill provisioning,
 * detector subprocess, live-LLM critique quality (loosely — presence, not
 * taste), report auto-write into .impeccable/critique/, and the
 * Move-to-Blueprint handoff.
 *
 * Run (real LLM, real app; ~5–15 min):
 *   LIVE_LLM=1 npx playwright test --project electron-live e2e/design-audit-live.e2e.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/electron-fixture'
import { SettingsNav } from './pages/settings-nav'

const IS_LIVE = process.env.LIVE_LLM === '1'
test.skip(!IS_LIVE, 'Set LIVE_LLM=1 to enable this test (manual — real LLM)')

// Deliberately imperfect UI file so both the detector and the critique pass
// have something honest to find.
function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-design-live-'))
  mkdirSync(join(dir, 'src', 'components'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'components', 'Dashboard.tsx'),
    [
      'export default function Dashboard(): JSX.Element {',
      '  return (',
      '    <div className="border-l-4 border-blue-500 bg-slate-900 p-4">',
      '      <h1 className="text-[9px] uppercase tracking-widest text-slate-400">Dashboard</h1>',
      '      <p className="text-amber-400 text-xs">Everything looks fine.</p>',
      '      <div className="rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 bg-clip-text text-transparent font-bold text-2xl">42</div>',
      '    </div>',
      '  )',
      '}'
    ].join('\n')
  )
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'live-design-fixture', version: '0.0.1' }, null, 2)
  )
  writeFileSync(join(dir, 'README.md'), '# Live design fixture\n')
  return dir
}

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ({ name, repoPath }) => {
      const api = (
        window as unknown as { api: { workspaceCreate: (a: unknown) => Promise<{ id: string }> } }
      ).api
      const res = await api.workspaceCreate({ name, repoPath })
      return res.id
    },
    { name, repoPath }
  )
}

test('live design audit: run → findings → report → Move to Blueprint', async ({ page }) => {
  test.setTimeout(15 * 60_000)
  const dir = makeRepoDir()
  const workspaceId = await createWorkspace(page, 'live-design', dir)

  // Home first (renderer restores the last workspace on reload), then open it.
  await page.goto('about:blank')
  await page.reload()
  const card = page.locator(`[data-testid="workspace-card"][data-workspace-id="${workspaceId}"]`)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.click()
  await expect(page.locator('[data-testid="unified-sidebar"]').first()).toBeVisible({
    timeout: 20_000
  })

  const settingsNav = new SettingsNav(page)
  await settingsNav.navigateToSettingsTab('design')
  await expect(page.locator('[data-testid="design-landing"]')).toBeVisible({ timeout: 15_000 })

  await page.locator('[data-testid="design-start-btn"]').first().click()
  await expect(page.locator('[data-testid="design-brief-step"]')).toBeVisible({ timeout: 10_000 })

  // Brief → cards (wait out the live route call) → scope → run.
  await page
    .locator('[data-testid="design-brief-input"]')
    .fill('Audit this dashboard component for accessibility and visual quality.')
  await page.locator('[data-testid="design-next-btn"]').click()
  await expect(page.locator('[data-testid="design-cards-step"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid="design-next-btn"]').click()
  await expect(page.locator('[data-testid="design-scope-step"]')).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-testid="design-run-btn"]').click()

  // The live gate: wait for the run to finish (report auto-writes on complete).
  await expect(page.locator('[data-testid="design-run-view"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="design-move-to-blueprint"]')).toBeVisible({
    timeout: 12 * 60_000
  })

  // Findings rendered for at least one pass.
  await expect(page.locator('[data-testid="design-findings-list"]').first()).toBeVisible({
    timeout: 10_000
  })

  // Report landed in Impeccable's tracked-artifact directory.
  const critiqueDir = join(dir, '.impeccable', 'critique')
  await expect
    .poll(
      async () =>
        existsSync(critiqueDir)
          ? readdirSync(critiqueDir).filter((f) => f.endsWith('.md')).length
          : 0,
      {
        timeout: 30_000
      }
    )
    .toBeGreaterThan(0)

  // Handoff: blueprint created + navigation to the blueprints tab.
  await page.locator('[data-testid="design-move-to-blueprint"]').click()
  await expect(page.locator('[data-testid="blueprint-page"]').first()).toBeVisible({
    timeout: 20_000
  })

  rmSync(dir, { recursive: true, force: true })
})

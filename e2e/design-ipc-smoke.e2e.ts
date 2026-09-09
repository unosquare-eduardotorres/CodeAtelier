/**
 * Design IPC surface — Fullstack E2E Test
 *
 * Drives the seven `design:*` invoke channels through the real preload against a
 * workspace seeded over IPC. Complements `design-wizard.e2e.ts`, which covers
 * the rendered wizard: this one pins the contract underneath it.
 *
 * The property that ties the file together is the **envelope**. Every
 * `design:*` handler answers `{ ok: true, data } | { ok: false, reason }`, and
 * the preload passes it through untouched — unwrapping by throwing would turn
 * refusals the UI renders as a message ("A design run is already in progress")
 * into exceptions. A spec that only checked `data` would not notice the day that
 * changed.
 *
 * Requires `CLAUDE_SHIM_DIR` for the same reason every seeded spec does: without
 * it the app boots into the developer profile and the spec would skip while
 * reporting coverage the suite does not have.
 *
 * Run:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim \
 *     npx playwright test --project=electron --workers=1 e2e/design-ipc-smoke.e2e.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR

test.skip(!IS_SHIM, 'Set CLAUDE_SHIM_DIR=e2e/helpers/claude-shim for an isolated profile')

test.setTimeout(180_000)

const tempDirs: string[] = []
const createdWorkspaceIds: string[] = []

type Envelope<T> = { ok: true; data: T } | { ok: false; reason: string }

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-design-ipc-'))
  mkdirSync(join(dir, 'ui', 'widgets'), { recursive: true })
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    writeFileSync(join(dir, 'ui', 'widgets', `${name}.tsx`), `export const ${name} = 1\n`)
  }
  writeFileSync(join(dir, 'ui', 'theme.css'), 'body { margin: 0; }\n')
  // Backend-only file — must never be counted as design-relevant.
  writeFileSync(join(dir, 'server.ts'), 'export const port = 3000\n')
  writeFileSync(join(dir, 'README.md'), '# E2E design IPC smoke\n')
  tempDirs.push(dir)
  return dir
}

async function createWorkspace(page: Page, repoPath: string): Promise<string> {
  const id = await page.evaluate(async (p) => {
    const ws = await (window as any).api.createWorkspace({ name: 'E2E design IPC', repoPath: p })
    return ws.id as string
  }, repoPath)
  createdWorkspaceIds.push(id)
  return id
}

test.afterAll(async ({ electronPage: page }) => {
  for (const id of createdWorkspaceIds) {
    await page
      .evaluate(async (workspaceId) => {
        await (window as any).api.deleteWorkspace({ id: workspaceId })
      }, id)
      .catch(() => {})
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test.describe('Design IPC surface', () => {
  test('scopeTree, route, history, cancel and delete all answer through the envelope', async ({
    electronPage: page
  }) => {
    const welcome = new WelcomePage(page)
    if (await welcome.isWelcomeModalVisible()) {
      await welcome.completeWelcomeModal('E2E Test')
    }

    const workspaceId = await createWorkspace(page, makeRepoDir())
    expect(workspaceId).toBeTruthy()

    // ── 1. design:scopeTree — the real walk, over the real filesystem ──
    const tree = await page.evaluate(
      async (id) => (window as any).api.designScopeTree({ workspaceId: id }),
      workspaceId
    )
    expect(tree.ok).toBe(true)
    const treeData = (tree as Envelope<any> & { ok: true }).data
    // 3 .tsx + 1 .css. server.ts and README.md are not design-relevant.
    expect(treeData.totalFiles).toBe(4)
    expect(treeData.suggested).toBe('ui')
    expect(treeData.truncated).toBe(false)

    const dirs = treeData.dirs as { path: string; fileCount: number }[]
    const byPath = Object.fromEntries(dirs.map((d) => [d.path, d.fileCount]))
    // Counts are cumulative: selecting `ui` reviews everything beneath it.
    expect(byPath['ui']).toBe(4)
    expect(byPath['ui/widgets']).toBe(3)

    // ── 2. design:route — never fails, never returns an invalid selection ──
    const routed = await page.evaluate(
      async (id) =>
        (window as any).api.designRoute({
          workspaceId: id,
          brief: 'this settings page feels generic and AI-made'
        }),
      workspaceId
    )
    expect(routed.ok).toBe(true)
    const route = (routed as Envelope<any> & { ok: true }).data
    expect(Array.isArray(route.commandIds)).toBe(true)
    expect(route.commandIds.length).toBeGreaterThan(0)
    expect(typeof route.usedFallback).toBe('boolean')
    expect(typeof route.rationale).toBe('string')
    // At least one evaluate pass, or the run would have nothing to execute.
    expect(route.commandIds.some((id: string) => id === 'audit' || id === 'critique')).toBe(true)
    // bolder+quieter and distill+animate are the matrix's live pairs.
    expect(route.commandIds.includes('bolder') && route.commandIds.includes('quieter')).toBe(false)
    expect(route.commandIds.includes('distill') && route.commandIds.includes('animate')).toBe(false)

    // ── 3. Read paths on a fresh workspace ──
    const history = await page.evaluate(
      async (id) => (window as any).api.designGetHistory({ workspaceId: id }),
      workspaceId
    )
    expect(history.ok).toBe(true)
    expect((history as Envelope<unknown[]> & { ok: true }).data).toEqual([])

    const latest = await page.evaluate(
      async (id) => (window as any).api.designGetLatest({ workspaceId: id }),
      workspaceId
    )
    expect(latest.ok).toBe(true)
    expect((latest as Envelope<unknown> & { ok: true }).data).toBeNull()

    // ── 4. Cancel with nothing running is a no-op, not an error ──
    const cancelled = await page.evaluate(
      async (id) => (window as any).api.designCancel({ workspaceId: id }),
      workspaceId
    )
    expect(cancelled.ok).toBe(true)

    // ── 5. Refusals arrive as values, not exceptions ──
    // Deleting a run that does not exist is the cheapest observable refusal, and
    // the same guard that stops the design page deleting a Workspace Health run.
    const deleted = await page.evaluate(
      async () => (window as any).api.designDeleteRun({ runId: 'does-not-exist' }),
      null
    )
    expect(deleted.ok).toBe(false)
    expect((deleted as Envelope<never> & { ok: false }).reason).toMatch(/not found/i)

    const missingWorkspace = await page.evaluate(async () =>
      (window as any).api.designScopeTree({ workspaceId: 'no-such-workspace' })
    )
    expect(missingWorkspace.ok).toBe(false)
    expect((missingWorkspace as Envelope<never> & { ok: false }).reason).toMatch(/not found/i)
  })
})

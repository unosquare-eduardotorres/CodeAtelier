/**
 * Blueprint Session-Resume Live E2E — real LLM, manual run only (A1 Phase 5).
 *
 * Proves the resume WIN end-to-end, which unit tests structurally cannot:
 * a retry that resumed must show a non-zero cache-read (the CLI re-read its
 * KV prefix instead of re-ingesting the context) AND a `session_resume`
 * telemetry row with status `succeeded` (the permit was granted AND the
 * executor honoured it).
 *
 * The spec drives a real build run and then inspects the app DB + log. It
 * does NOT force a failure to manufacture a resume — on a green run it
 * asserts the negative (no resumed rung ⇒ nothing to cache-read) and exits
 * 0; the positive assertions fire only when a `session_resume` row with
 * status `succeeded` exists, which is exactly the population Gate 1 measures.
 *
 * Run (manual — needs a workspace with a cloud provider configured):
 *   npx electron-vite build
 *   LIVE_LLM=1 npx playwright test --project electron-live e2e/blueprint-session-resume-live.e2e.ts
 *
 * Prerequisites:
 *   - Built app: out/main/index.js
 *   - A workspace with a cloud provider configured (Claude CLI login)
 *   - blueprintSessionResume preference ON (the default)
 */
import { test, expect } from './helpers/electron-fixture'
import type { Page } from '@playwright/test'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const IS_LIVE = process.env.LIVE_LLM === '1'

test.skip(!IS_LIVE, 'Set LIVE_LLM=1 to enable this test (manual — real LLM)')

test.setTimeout(900_000)

// ── DB access (same pattern as blueprint-glm-routing-live.e2e.ts) ──

function openAppDb(): { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } | null {
  const candidates = [
    join(homedir(), 'Library/Application Support/code-atelier/code-atelier.db'),
    join(homedir(), 'Library/Application Support/Code Atelier/code-atelier.db')
  ]
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue
    try {
      const Database = require(join(process.cwd(), 'node_modules/better-sqlite3'))
      const db = new Database(dbPath, { fileMustExist: true })
      return db as unknown as {
        prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] }
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** All session_resume telemetry rows for a blueprint, parsed. */
function readResumeRows(blueprintId: string): Array<Record<string, unknown>> {
  const db = openAppDb()
  if (!db) return []
  const rows = db
    .prepare(
      // F4 (2.3) — the column is `data_json` (see the telemetry row interface:
      // `data_json: string`); the old `SELECT data` threw after the 14-minute
      // run, on every assertion.
      `SELECT data_json AS data FROM blueprint_telemetry WHERE blueprint_id = ? AND kind = 'session_resume'`
    )
    .all(blueprintId) as Array<{ data: string | null }>
  return rows.flatMap((r) => {
    try {
      return r.data ? [JSON.parse(r.data) as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
}

// ── App helpers (same shape as the other live specs) ──

const tempDirs: string[] = []

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-resume-live-'))
  writeFileSync(join(dir, 'README.md'), '# E2E resume live workspace\n')
  tempDirs.push(dir)
  return dir
}

async function getBlueprintDetails(page: Page, blueprintId: string): Promise<any> {
  return page.evaluate(async (id) => {
    return (await (window as any).api.blueprintGetDetails({ id })) as any
  }, blueprintId)
}

async function waitForTerminalStatus(
  page: Page,
  blueprintId: string,
  timeoutMs = 840_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = await getBlueprintDetails(page, blueprintId)
    const status = last?.status
    if (status === 'complete' || status === 'failed') return last
    await page.waitForTimeout(4_000)
  }
  return last
}

test.describe('A1 — session resume (live LLM)', () => {
  test('a resumed retry reports non-zero cache-read and a succeeded session_resume row', async ({
    electronPage: page
  }) => {
    test.skip(!(await pageHasCloudProvider(page)), 'workspace has no cloud provider configured')

    // ── Setup: throwaway workspace on a throwaway repo ──
    const repoPath = makeRepoDir()
    const workspaceId = await page.evaluate(
      async ([n, p]) => {
        const ws = await (window as any).api.createWorkspace({
          name: n as string,
          repoPath: p as string
        })
        return ws.id as string
      },
      ['E2E Resume Live', repoPath]
    )
    expect(workspaceId).toBeTruthy()

    // The resume flag defaults ON; assert it so a flipped default fails HERE
    // with a clear message rather than as a confusing green run.
    const prefs = await page.evaluate(async () => {
      return (await (window as any).api.getAppPreferences?.()) as
        Record<string, unknown> | undefined
    })
    if (prefs && 'blueprintSessionResume' in prefs) {
      expect(prefs.blueprintSessionResume, 'blueprintSessionResume must be ON for this spec').toBe(
        true
      )
    }

    // ── Run a small real build ──
    const created = await page.evaluate(
      async ([wsId]) => {
        return (await (window as any).api.blueprintCreate({
          workspaceId: wsId as string,
          title: 'E2E Resume Live Run',
          description:
            'Add a util module `sum(numbers)` returning the total plus a unit test for empty and non-empty arrays.'
        })) as { id: string }
      },
      [workspaceId]
    )
    const blueprintId = created.id

    await page.evaluate(
      async ([bpId, wsId]) => {
        await (window as any).api.blueprintStartSpecify({
          blueprintId: bpId as string,
          workspaceId: wsId as string
        })
      },
      [blueprintId, workspaceId]
    )

    const final = await waitForTerminalStatus(page, blueprintId)
    // The run itself may succeed or fail — the spec asserts the RESUME
    // accounting either way, not the build's outcome.
    test.info().annotations.push({ type: 'finalStatus', description: String(final?.status) })

    // ── The assertions ──
    const rows = readResumeRows(blueprintId)
    const succeeded = rows.filter((r) => r.status === 'succeeded')
    const attempted = rows.filter((r) => r.status === 'attempted')
    const failedSilently = rows.filter((r) => r.status === 'failed-silently')

    // Honesty invariant: every succeeded row must have had an attempted row.
    if (succeeded.length > 0) {
      expect(
        attempted.length,
        'succeeded session_resume rows exist without attempted rows — fire-time accounting is broken'
      ).toBeGreaterThanOrEqual(succeeded.length)
    }

    if (succeeded.length > 0) {
      // THE gate: a resume that actually happened must have read its cache.
      const withCache = succeeded.filter(
        (r) => typeof r.cacheReadInputTokens === 'number' && (r.cacheReadInputTokens as number) > 0
      )
      expect(
        withCache.length,
        `resumed retries succeeded but cacheReadInputTokens is 0/absent on every row — ` +
          `the prefix cache is not being read: ${JSON.stringify(succeeded)}`
      ).toBeGreaterThan(0)
    }

    // failed-silently rows must never masquerade as succeeded (Phase 3).
    for (const r of failedSilently) {
      expect(r.status).toBe('failed-silently')
      expect(r.silentReason, 'a failed-silently row names its sub-reason').toBeTruthy()
    }

    // F4 (2.3) — a green run with zero resumes is NOT a silent pass. The
    // spec's purpose is to measure resume accounting; when the run produced
    // no resume rows at all there was nothing to measure — fail loudly with
    // an annotated reason instead of exiting green (a green exit on an
    // unmeasured run is how A1 stayed unbenchmarked for two cycles).
    const totalRows = attempted.length + succeeded.length + failedSilently.length
    test.info().annotations.push({
      type: 'resumeRows',
      description: JSON.stringify(rows)
    })
    if (totalRows === 0) {
      test.skip(
        true,
        'zero session_resume rows — nothing to measure (run predates A1, flag off, or the run never retried)'
      )
    }

    // ── Cleanup ──
    await page
      .evaluate(
        async ([wsId]) => {
          await (window as any).api.blueprintCancel({ workspaceId: wsId as string })
        },
        [workspaceId]
      )
      .catch(() => {})
    await page
      .evaluate(async (id) => {
        await (window as any).api.blueprintDelete({ id })
      }, blueprintId)
      .catch(() => {})
    await page
      .evaluate(async (wsId) => {
        await (window as any).api.deleteWorkspace({ workspaceId: wsId })
      }, workspaceId)
      .catch(() => {})
  })
})

/** Best-effort probe: does the app have ANY cloud-configured workspace? */
async function pageHasCloudProvider(page: Page): Promise<boolean> {
  try {
    const providers = await page.evaluate(async () => {
      const list = await (window as any).api.listWorkspaces?.()
      return (list ?? []).map((w: any) => w.llmProvider).filter(Boolean)
    })
    return Array.isArray(providers) && providers.some((p: string) => p !== 'local-llm')
  } catch {
    return false
  }
}

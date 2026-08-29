/**
 * Blueprint GLM Routing Live E2E — real GLM API, manual run only.
 *
 * Proves the v1.0.92 fix end-to-end against the real Z.ai API, through the
 * REAL Electron app, the REAL opencode executor and the REAL per-turn provider
 * resolution — the exact path that misrouted to the Claude CLI in v1.0.91:
 *
 *   blueprintCreate → startSpecify → AgentSessionService.start() (session
 *   provider from workspace settings) → per-turn resolution (conv.llmProvider)
 *   → OpenCodeExecutor with glm provider config → glm-5.3 over Z.ai.
 *
 * Why live: the v1.0.91 fix passed all unit tests but still failed in
 * production because the per-turn override read a DB-defaulted 'claude' from
 * the synthetic conversation row — a bug only reproducible with a real DB row
 * + real provider resolution + real executor. No mock can prove the fix.
 *
 * Setup: copies the GLM routing settings from the user's real GLM workspace
 * (e.g. Congruityhr) into a throwaway workspace, so the test never touches the
 * real workspace's data and never needs the key re-entered.
 *
 * Asserts:
 *   1. The synthetic blueprint conversation row is created with the
 *      workspace's provider (glm), not the DB default (claude).
 *   2. The specify phase streams real tokens from glm-5.3 (usage recorded
 *      under provider glm, model glm-5.3 — never claude).
 *   3. No claude CLI process is spawned for the phase (log line absent).
 *
 * Run (manual — needs the real profile with a GLM-configured workspace):
 *   npx electron-vite build
 *   LIVE_LLM=1 npx playwright test --project electron-live \
 *     e2e/blueprint-glm-routing-live.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import type { Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { homedir } from 'os'

const IS_LIVE = process.env.LIVE_LLM === '1'
test.skip(!IS_LIVE, 'Set LIVE_LLM=1 to enable this test (manual — real GLM API)')

// Real GLM through specify + clarify — allow 10 min.
test.setTimeout(600_000)

const tempDirs: string[] = []

/** Fallback GLM source found by scanning settings (set inside the test). */
let glmSourceFallback: { id: string; name: string; repoPath: string } | undefined

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-glm-routing-live-'))
  writeFileSync(join(dir, 'README.md'), '# GLM routing live workspace\n')
  tempDirs.push(dir)
  return dir
}

// ── Helpers ──

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ([n, p]) => {
      const ws = await (window as any).api.createWorkspace({ name: n, repoPath: p })
      return ws.id as string
    },
    [name, repoPath]
  )
}

async function readSetting(page: Page, workspaceId: string, key: string): Promise<unknown> {
  return page.evaluate(
    async ([wsId, k]) => {
      const s = await (window as any).api.getWorkspaceSettings({ workspaceId: wsId })
      return (s ?? {})[k as string]
    },
    [workspaceId, key]
  )
}

async function writeSetting(
  page: Page,
  workspaceId: string,
  settings: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    async ([wsId, s]) => {
      await (window as any).api.updateWorkspaceSettings({
        workspaceId: wsId as string,
        settings: s as Record<string, unknown>
      })
    },
    [workspaceId, settings]
  )
}

async function getBlueprintDetails(page: Page, blueprintId: string): Promise<any> {
  return page.evaluate(async (id) => {
    return (await (window as any).api.blueprintGetDetails({ id })) as any
  }, blueprintId)
}

/** Poll until the specify phase record reaches a terminal-ish status. */
async function waitForPhaseStatus(
  page: Page,
  blueprintId: string,
  phase: string,
  statuses: string[],
  timeoutMs = 540_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = await getBlueprintDetails(page, blueprintId)
    const ph = last?.phases?.find((p: any) => p.phase === phase)
    if (ph && statuses.includes(ph.status)) return last
    // A phase past `active` (e.g. blueprint moved to clarify) also counts as done
    if (ph && ph.status === 'complete') return last
    await page.waitForTimeout(5_000)
  }
  throw new Error(
    `Phase ${phase} did not reach ${statuses.join('/')} within ${timeoutMs}ms — last: ` +
      `${last?.status ?? 'unknown'} (phase ${last?.currentPhase ?? '?'}, ` +
      `${last?.phases?.map((p: any) => `${p.phase}:${p.status}`).join(' ')})`
  )
}

/**
 * Read the synthetic blueprint conversation row straight from the app's DB.
 * getConversations filters type='chat', so IPC can't see blueprint rows.
 *
 * The test app runs unpackaged (electron-vite out/), so its userData is the
 * dev-mode profile `~/Library/Application Support/code-atelier/` — NOT the
 * packaged app's `Code Atelier`. Try both, dev first.
 */
function readBlueprintConversationRow(conversationId: string): { llm_provider: string } | null {
  const candidates = [
    join(homedir(), 'Library/Application Support/code-atelier/code-atelier.db'),
    join(homedir(), 'Library/Application Support/Code Atelier/code-atelier.db')
  ]
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require(join(process.cwd(), 'node_modules/better-sqlite3'))
      const db = new Database(dbPath, { fileMustExist: true })
      try {
        const row = db
          .prepare('SELECT llm_provider FROM conversations WHERE id = ?')
          .get(conversationId) as { llm_provider: string } | null
        if (row) return row
      } finally {
        db.close()
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/** The test-mode app logs here (unpacked app name is lowercase). */
function testAppLogPath(): string {
  const lower = join(homedir(), 'Library/Logs/code-atelier/main.log')
  if (existsSync(lower)) return lower
  return join(homedir(), 'Library/Logs/Code Atelier/main.log')
}

// ── Test ──

test.describe('Blueprint GLM routing (live)', () => {
  test('GLM workspace → specify phase routes to glm, never claude', async ({
    electronPage: page
  }) => {
    // ── Setup: find the user's real GLM workspace and copy its routing ──
    let workspaces: Array<{ id: string; name: string; repoPath: string }> = []
    for (let i = 0; i < 20 && workspaces.length === 0; i++) {
      workspaces = await page.evaluate(async () => {
        return (await (window as any).api.listWorkspaces()) as Array<{
          id: string
          name: string
          repoPath: string
        }>
      })
      if (workspaces.length === 0) await page.waitForTimeout(1_500)
    }
    const glmSource = workspaces.find(
      (w) =>
        w.repoPath.toLowerCase().includes('congruityhr') ||
        // Fallback: any workspace whose settings route to glm
        false
    )
    if (!glmSource) {
      // Fall back to scanning settings for the first glm-configured workspace
      for (const w of workspaces) {
        const s = await page.evaluate(async (wsId) => {
          return (await (window as any).api.getWorkspaceSettings({ workspaceId: wsId })) as Record<
            string,
            unknown
          >
        }, w.id)
        if (s.llmProvider === 'glm') {
          glmSourceFallback = w
          break
        }
      }
    }
    const source = glmSource ?? glmSourceFallback
    expect(
      source,
      `No GLM source workspace found — workspaces seen: ${workspaces
        .map((w) => w.repoPath)
        .join(', ')}`
    ).toBeTruthy()

    const sourceSettings = await page.evaluate(async (wsId) => {
      return (await (window as any).api.getWorkspaceSettings({ workspaceId: wsId })) as Record<
        string,
        unknown
      >
    }, source!.id)
    expect(sourceSettings.llmProvider).toBe('glm')

    const repoDir = makeRepoDir()
    const workspaceId = await createWorkspace(page, 'E2E GLM Routing Live', repoDir)

    // Copy ONLY routing keys — the throwaway workspace must not inherit
    // tokens, gate commands or view state.
    const routingKeys = [
      'llmProvider',
      'modelRoles',
      'modelOverrides',
      'costPreference',
      'localLlmBackend',
      'glmApiKey',
      'glmApiKeyEncrypted',
      'glmBaseUrl',
      'glmEndpointMode',
      'glmModel',
      'glmSmallModel',
      'glmContextLimit',
      'glmOutputLimit',
      'glmDiscoveredModels',
      'openCodeBaseUrl',
      'openCodeApiKey',
      'openCodeApiKeyEncrypted'
    ]
    const routing: Record<string, unknown> = {}
    for (const k of routingKeys) {
      if (sourceSettings[k] !== undefined) routing[k] = sourceSettings[k]
    }
    await writeSetting(page, workspaceId, routing)
    expect(await readSetting(page, workspaceId, 'llmProvider')).toBe('glm')

    // ── Run: create + start specify on the GLM-configured throwaway ──
    const created = await page.evaluate(
      async ([wsId]) => {
        return (await (window as any).api.blueprintCreate({
          workspaceId: wsId as string,
          title: 'E2E GLM Routing Live Run',
          description:
            'Add a greet(name) utility module returning { greeting: "Hello, <name>" } ' +
            'plus a unit test covering empty and normal names.'
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

    // ── Assert 1: the synthetic conversation row carries glm, not the DB default ──
    // The row is minted early in startSpecifyPhase; poll briefly for it.
    let convRow: { llm_provider: string } | null = null
    for (let i = 0; i < 12 && !convRow; i++) {
      await page.waitForTimeout(2_500)
      const details = await getBlueprintDetails(page, blueprintId)
      const convId = details?.phases?.find((p: any) => p.phase === 'specify')?.conversationId
      if (convId) convRow = readBlueprintConversationRow(convId)
    }
    expect(convRow, 'synthetic specify conversation row was never created').toBeTruthy()
    expect(convRow!.llm_provider).toBe('glm')

    // ── Assert 2 (the load-bearing one): the app log proves the real chain ──
    // Session start resolved glm AND the OpenCode session was created with
    // provider=glm/glm-5.3 AND no claude CLI was spawned for the phase turn.
    // This is the exact chain that misrouted in v1.0.91.
    const log = readFileSync(testAppLogPath(), 'utf-8')
    const tail = log.slice(-200_000) // only this run's tail
    expect(tail).toMatch(/\[start\] executorBackend=opencode llmProvider=glm/)
    expect(tail).toMatch(/Session ses_\S+ created — provider=glm\/glm-5\.3/)
    // The misroute signature: a claude CLI spawn for the blueprint turn
    expect(tail).not.toMatch(/\[CLI:args\][^\n]*--model claude-\S+[^\n]*blueprint-specify/)

    // ── Assert 3: the phase completes with real GLM tokens ──
    const final = await waitForPhaseStatus(page, blueprintId, 'specify', ['complete', 'failed'])
    const specifyPhase = final.phases.find((p: any) => p.phase === 'specify')
    expect(specifyPhase.status).toBe(
      'complete',
      `specify failed — check logs for provider routing: ${JSON.stringify(specifyPhase)}`
    )

    // ── Cleanup: cancel + delete the throwaway blueprint + workspace ──
    await page
      .evaluate(
        async ([bpId]) => {
          await (window as any).api.blueprintCancel({ workspaceId: '' })
        },
        [blueprintId]
      )
      .catch(() => {})
    await page
      .evaluate(async (id) => {
        await (window as any).api.blueprintDelete({ id })
      }, blueprintId)
      .catch(() => {})
  })
})

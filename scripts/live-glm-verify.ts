/**
 * LIVE GLM verification for the stale-session.idle fix (v1.0.86 → v1.0.87).
 *
 * Reproduces the exact production race against the real Z.ai API:
 *   getOrCreateSession() → primeSession() (noReply prompt — completes fast)
 *   → event.subscribe() → stale session.idle from the priming tail arrives
 *   → real prompt sent → (pre-fix) stream broke in ~15–70ms with textLen=0,
 *   input=0 output=0. With the fix, the stale idle is ignored and the real
 *   prompt streams to completion.
 *
 * Runs the REAL OpenCodeExecutor (src/main/services/opencode-executor.ts)
 * with the REAL opencode CLI server — no mocks. The GLM API key comes from
 * the GLM_API_KEY env var (never hardcoded).
 *
 * Usage:
 *   GLM_API_KEY=... node --import tsx scripts/live-glm-verify.mjs
 *
 * Exit 0 = fix verified (text streamed, tokens counted).
 * Exit 1 = failure (details printed).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const API_KEY = process.env.GLM_API_KEY
if (!API_KEY) {
  console.error('[live-glm-verify] GLM_API_KEY env var is required')
  process.exit(1)
}

const WORKSPACE = process.env.GLM_VERIFY_CWD ?? resolve(process.cwd(), '../Congruityhr')
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const MODEL_ID = 'glm-5.3'

// Mirror the app's opencode-config-writer output for a GLM workspace
// (npm provider, verbatim baseURL, declared model capabilities + limits).
const config = {
  $schema: 'https://opencode.ai/config.json',
  default_agent: 'davinci',
  provider: {
    glm: {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: BASE_URL,
        apiKey: API_KEY,
        timeout: 300_000,
        chunkTimeout: 15_000
      },
      models: {
        [MODEL_ID]: {
          tool_call: true,
          attachment: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 200_000, output: 131_072 }
        }
      }
    }
  }
}

const tempDir = mkdtempSync(join(tmpdir(), 'live-glm-verify-'))
const configPath = join(tempDir, 'opencode.json')
writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })

// Install the same electron/electron-log stubs + .sql?raw loader the unit-test
// harness uses (see __tests__/electron-stub.ts) — the executor's import chain
// pulls in db/index.ts which requires schema.sql?raw.
async function main(): Promise<void> {
  const { setupElectronStub } = await import('../src/main/services/__tests__/electron-stub')
  setupElectronStub()
  // Resolve the opencode CLI path the same way the app does at startup
  const { resolveOpencodePath } = await import('../src/shared/opencode-cli-path')
  resolveOpencodePath()

  const { OpenCodeExecutor } = await import('../src/main/services/opencode-executor')

  // Debug tap: mirror every openCodeLog call to stdout so we can see the
  // 'stale session.idle — ignoring' line and usage parsing live.
  const logEvents: string[] = []
  const origInfo = console.info
  console.info = (...args: unknown[]) => {
    const line = args.map(String).join(' ')
    if (line.includes('[opencode]')) logEvents.push(line)
    origInfo(...args)
  }

  const executor = new OpenCodeExecutor()

  // Instrumentation: record raw event types + isSessionComplete decisions.
  // (The harness electron-log mock is a no-op, so we tap the private methods.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyExec = executor as any
  const eventTypes: string[] = []
  const completeChecks: string[] = []
  const usageDumps: string[] = []
  const origNorm = anyExec.normalizeEvent.bind(executor)
  anyExec.normalizeEvent = (event: unknown, sid: string, tu: unknown) => {
    const type = (event as { type?: string })?.type ?? '?'
    eventTypes.push(type)
    // Dump usage-bearing payloads to chase the input=0/output=0 question
    if (type === 'session.updated' || type === 'message.updated') {
      const props = (event as { properties?: Record<string, unknown> })?.properties ?? {}
      const usage = props.usage as Record<string, unknown> | undefined
      const msgInfo = props.info as Record<string, unknown> | undefined
      if (usage || msgInfo?.usage) {
        usageDumps.push(`${type}: ${JSON.stringify(usage ?? msgInfo?.usage).slice(0, 220)}`)
      }
    }
    return origNorm(event, sid, tu)
  }
  const origComplete = anyExec.isSessionComplete.bind(executor)
  anyExec.isSessionComplete = (event: unknown, sid: string, retries: boolean, saw: boolean) => {
    const type = (event as { type?: string })?.type ?? '?'
    const verdict = origComplete(event, sid, retries, saw)
    completeChecks.push(`${type} saw=${saw} → ${verdict}`)
    return verdict
  }
  console.log('[live-glm-verify] Starting OpenCode server (real CLI, GLM provider)…')
  await executor.start(WORKSPACE, { configPath })

  try {
    // ── Turn 1: priming + real prompt (the v1.0.86 broken path) ──
    console.log('\n[live-glm-verify] TURN 1 — priming context + real prompt (the race path)')
    const chunks1: Array<Record<string, unknown>> = []
    let text1 = ''
    let usage1: Record<string, number> | undefined
    let terminal1 = ''
    for await (const chunk of executor.execute({
      prompt: 'Reply with exactly: STALE-IDLE-FIX-VERIFIED',
      systemPrompt: 'You are a verification agent. Follow instructions exactly.',
      provider: { providerId: 'glm', modelId: MODEL_ID, baseUrl: BASE_URL, apiKey: API_KEY },
      cwd: WORKSPACE,
      conversationId: 'live-glm-verify-conv',
      primingContext: [{ type: 'text', text: 'Workspace context: Congruityhr live verification.' }],
      maxTurns: 3
    })) {
      chunks1.push(chunk as Record<string, unknown>)
      if (chunk.type === 'text' && chunk.content) text1 += chunk.content
      if (chunk.type === 'status' && chunk._meta) {
        usage1 = chunk._meta.tokenUsage
        terminal1 = chunk._meta.terminalReason ?? ''
      }
    }

    const textLen = text1.length
    console.log(`[live-glm-verify] TURN 1 result: chunks=${chunks1.length} textLen=${textLen}`)
    console.log(
      `[live-glm-verify]   input=${usage1?.input ?? 0} output=${usage1?.output ?? 0} terminal=${terminal1}`
    )
    console.log(`[live-glm-verify]   text: ${JSON.stringify(text1.slice(0, 200))}`)

    let ok = true
    if (textLen === 0) {
      console.error('[live-glm-verify] FAIL — empty text (the v1.0.86 bug signature)')
      ok = false
    }
    if (!usage1 || (usage1.input ?? 0) === 0 || (usage1.output ?? 0) === 0) {
      console.error('[live-glm-verify] FAIL — zero token usage (model never queried)')
      ok = false
    }

    // ── Turn 2: same session reuse (the orphaned-prompt race) ──
    console.log('\n[live-glm-verify] TURN 2 — same-session reuse (orphaned-prompt race)')
    const chunks2: Array<Record<string, unknown>> = []
    let text2 = ''
    let usage2: Record<string, number> | undefined
    for await (const chunk of executor.execute({
      prompt: 'Now reply with exactly: SECOND-TURN-OK',
      systemPrompt: 'You are a verification agent. Follow instructions exactly.',
      provider: { providerId: 'glm', modelId: MODEL_ID, baseUrl: BASE_URL, apiKey: API_KEY },
      cwd: WORKSPACE,
      conversationId: 'live-glm-verify-conv',
      maxTurns: 3
    })) {
      chunks2.push(chunk as Record<string, unknown>)
      if (chunk.type === 'text' && chunk.content) text2 += chunk.content
      if (chunk.type === 'status' && chunk._meta) usage2 = chunk._meta.tokenUsage
    }
    console.log(`[live-glm-verify] TURN 2 result: chunks=${chunks2.length} textLen=${text2.length}`)
    console.log(
      `[live-glm-verify]   input=${usage2?.input ?? 0} output=${usage2?.output ?? 0}`
    )
    console.log(`[live-glm-verify]   text: ${JSON.stringify(text2.slice(0, 200))}`)

    if (text2.length === 0) {
      console.error('[live-glm-verify] FAIL — turn 2 empty text (orphaned-prompt race)')
      ok = false
    }
    if (!usage2 || (usage2.output ?? 0) === 0) {
      console.error('[live-glm-verify] FAIL — turn 2 zero output tokens')
      ok = false
    }

    console.log(`\n[live-glm-verify] ${ok ? '✅ FIX VERIFIED LIVE' : '❌ VERIFICATION FAILED'}`)
    console.log(`\n[live-glm-verify] raw event sequence (${eventTypes.length} events):`)
    console.log(`  ${eventTypes.join(' → ')}`)
    console.log(`\n[live-glm-verify] isSessionComplete checks:`)
    for (const c of completeChecks) console.log(`  ${c}`)
    console.log(`\n[live-glm-verify] usage payloads seen (${usageDumps.length}):`)
    for (const u of usageDumps.slice(0, 10)) console.log(`  ${u}`)
    process.exitCode = ok ? 0 : 1
  } finally {
    await executor.stop()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

void main()

/**
 * Diagnostic integration test for OpenCode session flow.
 *
 * Isolates each SDK call with wall-clock timing to pinpoint where hangs occur
 * in the real oMLX flow. Unlike the bundled integration test, each step is
 * individually timed and independently timeout-guarded.
 *
 * Requires:
 *   - `opencode` CLI installed (v1.17+)
 *   - oMLX server running at OMLX_BASE_URL (default: http://100.70.141.52:8000)
 *
 * Run standalone (NOT registered in run-tests.ts):
 *   npx tsx src/main/services/__tests__/opencode-session-diagnostic.test.ts
 *
 * Environment overrides:
 *   OMLX_BASE_URL  — default: http://100.70.141.52:8000
 *   OMLX_MODEL     — default: omlx/Qwen3.5-122B-A10B-4bit
 *   OMLX_API_KEY   — default: PATKEY
 *   TEST_WORKSPACE — default: os.tmpdir()
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { OpenCodeExecutor } from '../opencode-executor'
import {
  augmentOpenCodeCliPath,
  resolveOpencodePath
} from '../../../shared/opencode-cli-path'

// ── Bootstrap: resolve CLI path before any test touches the executor ──
// Outside Electron, resolveOpencodePath() is never called at startup.
// We must call it explicitly so getOpencodePath() returns non-null.
augmentOpenCodeCliPath()
resolveOpencodePath()

// ── Config ──
const OMLX_BASE_URL = process.env.OMLX_BASE_URL ?? 'http://100.70.141.52:8000'
const OMLX_MODEL = process.env.OMLX_MODEL ?? 'omlx/Qwen3.5-122B-A10B-4bit'
const OMLX_API_KEY = process.env.OMLX_API_KEY ?? 'PATKEY'
const TEST_WORKSPACE = process.env.TEST_WORKSPACE ?? tmpdir()

// ── Shared state (mutated sequentially via runExclusive) ──
let executor: OpenCodeExecutor
let configDir: string
let configPath: string
let sessionId: string

// ── Helpers ──

/** Diagnostic logger with timestamp */
function diag(step: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
  console.log(`[DIAG] [${ts}] ${step}: ${msg}`)
}

/**
 * Wrap a promise in a timeout race. On timeout, logs the label and rejects
 * with a descriptive error so we see exactly which step hung.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      diag(label, `TIMED OUT after ${ms}ms`)
      reject(new Error(`[DIAG] ${label}: TIMED OUT after ${ms}ms`))
    }, ms)

    promise.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Run a timed step: logs start/complete/fail with elapsed ms.
 * Returns the step's result on success.
 */
async function timedStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  diag(step, 'started')
  const t0 = performance.now()
  try {
    const result = await fn()
    const elapsed = Math.round(performance.now() - t0)
    diag(step, `completed in ${elapsed}ms`)
    return result
  } catch (err) {
    const elapsed = Math.round(performance.now() - t0)
    diag(step, `FAILED after ${elapsed}ms — ${(err as Error).message}`)
    throw err
  }
}

/**
 * Build a minimal opencode.json for oMLX — no Electron dependencies.
 * Mirrors the existing integration test's writeTestConfig but validates
 * the schema properties the plan requires (tools.skill=boolean, shell=string).
 */
function writeTestConfig(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: OMLX_MODEL,
    autoupdate: false,
    provider: {
      omlx: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: OMLX_BASE_URL.replace(/\/$/, '') + '/v1',
          ...(OMLX_API_KEY ? { apiKey: OMLX_API_KEY } : {}),
          timeout: 300000,
          chunkTimeout: 120000
        },
        models: {
          [OMLX_MODEL.replace('omlx/', '')]: {
            name: OMLX_MODEL.replace('omlx/', ''),
            limit: { context: 32768, output: 8192 }
          }
        }
      }
    },
    disabled_providers: ['anthropic', 'openai', 'google', 'aws'],
    mcp: {},
    instructions: [],
    plugin: [],
    // B-5: skill must be boolean, shell must be string — schema compliance
    tools: { question: false, skill: true },
    permission: { Read: 'allow', Glob: 'allow', Grep: 'allow' },
    shell: '/bin/bash',
    share: 'disabled',
    server: { mdns: false }
  }
  const p = join(dir, 'opencode.json')
  writeFileSync(p, JSON.stringify(config, null, 2))
  return p
}

// ── Tests ──

describe('OpenCode Session Diagnostic — step-by-step timing', () => {
  // ── Step 1: Health check ──
  test('1. health: oMLX reachable', () =>
    runExclusive(async () => {
      await timedStep('health', async () => {
        const url = `${OMLX_BASE_URL}/v1/models`
        diag('health', `GET ${url}`)

        const { execSync } = await import('node:child_process')
        const curlCmd = `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${OMLX_API_KEY}" "${url}"`
        const statusCode = execSync(curlCmd, { timeout: 5000 }).toString().trim()

        diag('health', `HTTP ${statusCode}`)
        assert.ok(
          statusCode === '200' || statusCode === '401' || statusCode === '403',
          `oMLX should be reachable at ${OMLX_BASE_URL}, got HTTP ${statusCode}`
        )
      })
    })
  )

  // ── Step 2: Config generation ──
  test('2. config: generate valid opencode.json', () =>
    runExclusive(async () => {
      await timedStep('config', async () => {
        configDir = join(tmpdir(), `opencode-diag-${Date.now()}`)
        configPath = writeTestConfig(configDir)
        diag('config', `Written to: ${configPath}`)

        // Read back and validate schema properties
        const { readFileSync } = await import('node:fs')
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))

        // Schema regression checks
        assert.equal(typeof config.tools?.skill, 'boolean', 'tools.skill must be boolean')
        assert.equal(config.tools.skill, true, 'tools.skill should be true')
        assert.equal(typeof config.shell, 'string', 'shell must be a string')
        assert.ok(
          config.provider?.omlx?.options?.apiKey,
          'provider.omlx.options.apiKey should be present'
        )
        assert.equal(config.model, OMLX_MODEL, `model should be ${OMLX_MODEL}`)

        diag(
          'config',
          `model=${config.model}, tools.skill=${config.tools.skill}, shell=${config.shell}`
        )
      })
    })
  )

  // ── Step 3: Start server ──
  test('3. server: start OpenCode', () =>
    runExclusive(async () => {
      await timedStep('server-start', async () => {
        executor = new OpenCodeExecutor()
        process.env.OPENCODE_CONFIG = configPath

        await withTimeout(
          executor.start(TEST_WORKSPACE, { configPath, isLocal: true }),
          30_000,
          'server-start'
        )

        assert.equal(executor.isRunning(), true, 'Server should be running after start()')
        diag('server-start', `isRunning=${executor.isRunning()}`)
      })
    })
  )

  // ── Step 4: Wait for connected event ──
  test('4. server: wait for connected event', () =>
    runExclusive(async () => {
      await timedStep('server-connected', async () => {
        const client = executor.getClient()
        assert.ok(client, 'Client should be available after start()')

        // The server.connected event fires when MCP handshakes complete.
        // We subscribe briefly and see if any events arrive within 10s.
        let connected = false

        try {
          const eventsPromise = client!.event.subscribe()
          const events = await withTimeout(eventsPromise, 10_000, 'event-subscribe')

          if (events.stream) {
            // Try to read a few events with a short timeout
            const readPromise = (async () => {
              for await (const event of events.stream as AsyncIterable<unknown>) {
                const evt = event as Record<string, unknown>
                diag(
                  'server-connected',
                  `event type: ${evt.type ?? JSON.stringify(evt).slice(0, 120)}`
                )
                if (
                  evt.type === 'server.connected' ||
                  String(evt.type).includes('connect')
                ) {
                  connected = true
                  break
                }
                // Don't block forever — break after first event
                break
              }
            })()
            await Promise.race([readPromise, new Promise((r) => setTimeout(r, 5_000))])
          }
        } catch (err) {
          diag('server-connected', `subscribe error: ${(err as Error).message}`)
        }

        diag('server-connected', `server.connected received: ${connected}`)
        // Don't assert — some configurations don't emit this event; the diagnostic
        // value is in the timing log.
      })
    })
  )

  // ── Step 5: Create session ──
  test('5. session: create', () =>
    runExclusive(async () => {
      await timedStep('session-create', async () => {
        // Brief stabilization wait (no MCP servers configured, so fast)
        await new Promise((r) => setTimeout(r, 2000))

        const client = executor.getClient()
        assert.ok(client, 'Client should be available')

        const session = await withTimeout(
          client!.session.create({
            body: { title: 'Diagnostic test session' }
          }),
          10_000,
          'session-create'
        )

        sessionId = session.data?.id ?? ''
        assert.ok(
          sessionId,
          `Session ID should be defined, got: ${JSON.stringify(session.data)}`
        )
        assert.equal(typeof sessionId, 'string')
        diag('session-create', `sessionId=${sessionId}`)
      })
    })
  )

  // ── Step 6: file.status() — potential hang point ──
  test('6. sdk: file.status() (potential hang point)', () =>
    runExclusive(async () => {
      await timedStep('file-status', async () => {
        const client = executor.getClient()
        assert.ok(client, 'Client should be available')

        try {
          const status = await withTimeout(client!.file.status({}), 5_000, 'file-status')
          const files = status.data ?? []
          diag('file-status', `returned ${files.length} files`)
        } catch (err) {
          // Log but don't fail unless it timed out — timing is what matters
          diag('file-status', `error: ${(err as Error).message}`)
          if ((err as Error).message.includes('TIMED OUT')) throw err
        }
      })
    })
  )

  // ── Step 7: event.subscribe() — potential hang point ──
  test('7. sdk: event.subscribe() (potential hang point)', () =>
    runExclusive(async () => {
      await timedStep('event-subscribe', async () => {
        const client = executor.getClient()
        assert.ok(client, 'Client should be available')

        const events = await withTimeout(
          client!.event.subscribe(),
          5_000,
          'event-subscribe'
        )

        diag('event-subscribe', `stream present: ${!!events.stream}`)
        assert.ok(events, 'event.subscribe() should return an object')
      })
    })
  )

  // ── Step 8: session.prompt (noReply) — potential hang point ──
  test('8. sdk: session.prompt (noReply priming)', () =>
    runExclusive(async () => {
      await timedStep('prompt-noReply', async () => {
        const client = executor.getClient()
        assert.ok(client, 'Client should be available')
        assert.ok(sessionId, 'Session ID must exist from step 5')

        await withTimeout(
          client!.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [
                { type: 'text', text: '[System Instructions]\nYou are a concise assistant.' }
              ],
              noReply: true
            }
          }),
          10_000,
          'prompt-noReply'
        )

        diag('prompt-noReply', 'priming accepted (noReply)')
      })
    })
  )

  // ── Step 9: session.prompt (real) — cold start, up to 2 min ──
  test('9. sdk: session.prompt (real response, up to 2 min)', () =>
    runExclusive(async () => {
      await timedStep('prompt-real', async () => {
        const client = executor.getClient()
        assert.ok(client, 'Client should be available')
        assert.ok(sessionId, 'Session ID must exist from step 5')

        // Subscribe to events before sending the prompt
        const events = await client!.event.subscribe()

        // Fire the prompt (don't await — events arrive on the stream)
        const promptStart = performance.now()
        client!.session
          .prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text', text: 'Reply with exactly: "diagnostic ok"' }],
              model: {
                providerID: 'omlx',
                modelID: OMLX_MODEL.replace('omlx/', '')
              }
            }
          })
          .catch((err) => {
            diag('prompt-real', `prompt send error: ${(err as Error).message}`)
          })

        // Iterate the event stream with a 120s timeout
        let firstDeltaMs: number | null = null
        let responseText = ''
        let eventCount = 0

        const streamReader = (async () => {
          for await (const event of events.stream as AsyncIterable<unknown>) {
            eventCount++
            const evt = event as Record<string, unknown>
            const evtType = String(evt.type ?? '')

            // Log first few events for diagnosis
            if (eventCount <= 5) {
              diag('prompt-real', `event #${eventCount}: type=${evtType}`)
            }

            // Track first text delta (TTFT)
            if (
              evtType.includes('text') ||
              evtType.includes('delta') ||
              evtType.includes('content')
            ) {
              if (firstDeltaMs === null) {
                firstDeltaMs = Math.round(performance.now() - promptStart)
                diag('prompt-real', `TTFT (time-to-first-token): ${firstDeltaMs}ms`)
              }
              // Accumulate text
              const content =
                (evt as any).properties?.content ??
                (evt as any).content ??
                (evt as any).data?.content ??
                ''
              if (content) responseText += String(content)
            }

            // Check for completion
            if (
              evtType.includes('complete') ||
              evtType.includes('done') ||
              evtType.includes('finish') ||
              evtType === 'message.complete'
            ) {
              diag('prompt-real', `completion event: ${evtType}`)
              break
            }

            // Check for errors
            if (evtType.includes('error')) {
              diag('prompt-real', `error event: ${JSON.stringify(evt).slice(0, 200)}`)
              break
            }
          }
        })()

        await withTimeout(streamReader, 120_000, 'prompt-real')

        diag(
          'prompt-real',
          `events received: ${eventCount}, TTFT: ${firstDeltaMs ?? 'none'}ms`
        )
        diag('prompt-real', `response (first 200 chars): ${responseText.slice(0, 200)}`)
        assert.ok(eventCount > 0, 'Should have received at least one event')
      })
    })
  )

  // ── Step 10: executor.execute() round-trip — full code path ──
  test('10. full: executor.execute() round-trip (up to 3 min)', () =>
    runExclusive(async () => {
      await timedStep('execute-roundtrip', async () => {
        let receivedText = ''
        let receivedError = ''
        let chunkCount = 0
        let firstTextMs: number | null = null
        const t0 = performance.now()
        const chunkTypes = new Map<string, number>()

        const executeGen = executor.execute({
          prompt: 'Respond with exactly: "executor diagnostic ok"',
          systemPrompt:
            'You are a concise assistant. Respond with the exact text requested.',
          provider: {
            providerId: 'omlx',
            modelId: OMLX_MODEL.replace('omlx/', ''),
            baseUrl: OMLX_BASE_URL,
            apiKey: OMLX_API_KEY
          },
          cwd: TEST_WORKSPACE,
          maxTurns: 1
        })

        // Wrap the async generator iteration in a timeout
        const iterateStream = (async () => {
          for await (const chunk of executeGen) {
            chunkCount++
            const ctype = chunk.type ?? 'unknown'
            chunkTypes.set(ctype, (chunkTypes.get(ctype) ?? 0) + 1)

            if (ctype === 'text' && chunk.content) {
              receivedText += chunk.content
              if (firstTextMs === null) {
                firstTextMs = Math.round(performance.now() - t0)
                diag('execute-roundtrip', `first text chunk at ${firstTextMs}ms`)
              }
            }
            if (ctype === 'error' && chunk.error) {
              receivedError = chunk.error
              diag('execute-roundtrip', `error: ${receivedError.slice(0, 200)}`)
            }

            // Log every 10th chunk for progress visibility
            if (chunkCount % 10 === 0) {
              diag('execute-roundtrip', `${chunkCount} chunks so far...`)
            }
          }
        })()

        await withTimeout(iterateStream, 180_000, 'execute-roundtrip')

        // Summary
        const chunkSummary = Array.from(chunkTypes.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        diag(
          'execute-roundtrip',
          `total chunks: ${chunkCount} — types: {${chunkSummary}}`
        )
        diag('execute-roundtrip', `TTFT: ${firstTextMs ?? 'none'}ms`)
        diag(
          'execute-roundtrip',
          `response (first 200): ${receivedText.slice(0, 200)}`
        )

        assert.equal(
          receivedError,
          '',
          `Should have no errors, got: ${receivedError.slice(0, 300)}`
        )
        assert.ok(receivedText.length > 0, 'Should receive text response')
      })
    })
  )

  // ── Step 11: Cleanup ──
  test('11. cleanup: stop server', () =>
    runExclusive(async () => {
      await timedStep('cleanup', async () => {
        await executor.stop()
        assert.equal(executor.isRunning(), false, 'Server should be stopped')

        rmSync(configDir, { recursive: true, force: true })
        delete process.env.OPENCODE_CONFIG
        diag('cleanup', 'server stopped, temp dir removed')
      })
    })
  )
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

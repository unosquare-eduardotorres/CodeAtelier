/**
 * Unit tests for OpenCodeExecutor.sumAssistantTokensSince — the post-turn token
 * backstop for providers (GLM) that never emit usage on session.updated.
 *
 * Regression context: `session.messages()` resolves to
 * `Array<{ info: Message; parts: Part[] }>`, but the loop read `role`/`tokens`
 * off the array element. `entry.role` was undefined, so every message was
 * skipped on the loop's first line and the backstop silently recorded zero
 * tokens for every GLM blueprint turn.
 *
 * Run via the suite (needs the shared electron stub installed first):
 *   npm run test:unit
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeExecutor } from '../opencode-executor'
import type { ExecutorTokenUsage } from '../executor-types'

/**
 * The same module instance the executor's `electron-log/main` import resolves to
 * (electron-stub rewrites that specifier to this file, and Node caches by
 * resolved path). Required directly rather than imported so the handle is the
 * mock's own exports, including its warn/error recorder.
 */
const logMock = createRequire(import.meta.url)('./__electron_log_mock.cjs') as {
  __findRecords(level: string, substring: string): Array<{ level: string; message: string }>
}

// ── Helpers ──

function freshUsage(): ExecutorTokenUsage {
  return { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

/** Message in the real SDK shape: token fields live under `info`. */
function sdkAssistant(
  createdSeconds: number,
  tokens: Record<string, unknown> = { input: 100, output: 20, reasoning: 0 }
): Record<string, unknown> {
  return {
    info: {
      id: `msg_${createdSeconds}`,
      role: 'assistant',
      time: { created: createdSeconds },
      cost: 0.01,
      tokens: { cache: { read: 0, write: 0 }, ...tokens }
    },
    parts: []
  }
}

/**
 * Builds an executor whose `session.messages()` answers with `messages`.
 * Returns the executor plus the resolved counted/usage after a call.
 */
async function sumWith(
  messages: unknown[],
  sinceMs: number,
  usage: ExecutorTokenUsage
): Promise<number> {
  const executor = new OpenCodeExecutor()
  ;(executor as unknown as { client: unknown }).client = {
    session: { messages: async () => ({ data: messages }) }
  }
  return (
    executor as unknown as {
      sumAssistantTokensSince(s: string, since: number, u: ExecutorTokenUsage): Promise<number>
    }
  ).sumAssistantTokensSince('ses_test', sinceMs, usage)
}

const T0_SECONDS = 1_760_000_000
const T0_MS = T0_SECONDS * 1000

// ── Real SDK shape ──

describe('sumAssistantTokensSince — real SDK shape', () => {
  test('accumulates input/output/cache from info.tokens', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        sdkAssistant(T0_SECONDS + 10, {
          input: 1000,
          output: 200,
          cache: { read: 50_000, write: 4000 }
        }),
        sdkAssistant(T0_SECONDS + 20, {
          input: 1500,
          output: 300,
          cache: { read: 60_000, write: 0 }
        })
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 2)
    assert.equal(usage.input, 2500)
    assert.equal(usage.output, 500)
    assert.equal(usage.cacheReadInputTokens, 110_000)
    assert.equal(usage.cacheCreationInputTokens, 4000)
  })

  test('skips non-assistant messages', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        { info: { role: 'user', time: { created: T0_SECONDS + 5 } }, parts: [] },
        sdkAssistant(T0_SECONDS + 10, { input: 700, output: 70 })
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 1)
    assert.equal(usage.input, 700)
  })

  test('reasoning tokens are NOT folded into output (matches the live event path)', async () => {
    const usage = freshUsage()
    await sumWith(
      [sdkAssistant(T0_SECONDS + 10, { input: 900, output: 120, reasoning: 4000 })],
      T0_MS,
      usage
    )
    assert.equal(usage.output, 120)
  })

  test('messages with zero input and output are not counted', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [sdkAssistant(T0_SECONDS + 10, { input: 0, output: 0 })],
      T0_MS,
      usage
    )
    assert.equal(counted, 0)
    assert.equal(usage.input, 0)
  })
})

// ── Gate T: first-call prefix ──

describe('sumAssistantTokensSince — firstCallContextTokens (Gate T)', () => {
  test('is the FIRST message prompt size, never the accumulated sum', async () => {
    const usage = freshUsage()
    await sumWith(
      [
        sdkAssistant(T0_SECONDS + 10, {
          input: 1000,
          output: 200,
          cache: { read: 50_000, write: 0 }
        }),
        sdkAssistant(T0_SECONDS + 20, {
          input: 90_000,
          output: 300,
          cache: { read: 60_000, write: 0 }
        })
      ],
      T0_MS,
      usage
    )
    // input + cache.read of the EARLIEST message only.
    assert.equal(usage.firstCallContextTokens, 51_000)
    // The sum is far larger — recording it here is the 10-30x over-count the
    // "no summed-total fallback" contract exists to prevent.
    assert.equal(usage.input + usage.cacheReadInputTokens, 201_000)
  })

  test('an out-of-order list still yields the earliest message', async () => {
    const usage = freshUsage()
    await sumWith(
      [
        sdkAssistant(T0_SECONDS + 40, { input: 8000, output: 10, cache: { read: 0, write: 0 } }),
        sdkAssistant(T0_SECONDS + 5, { input: 700, output: 10, cache: { read: 100, write: 0 } })
      ],
      T0_MS,
      usage
    )
    assert.equal(usage.firstCallContextTokens, 800)
  })

  test('stays undefined when nothing matched — NULL, not a wrong number', async () => {
    const usage = freshUsage()
    await sumWith([sdkAssistant(T0_SECONDS - 600, { input: 5000, output: 10 })], T0_MS, usage)
    assert.equal(usage.firstCallContextTokens, undefined)
  })

  test('a zero prompt size is left unset rather than recorded as 0', async () => {
    const usage = freshUsage()
    await sumWith(
      [sdkAssistant(T0_SECONDS + 10, { input: 0, output: 250, cache: { read: 0, write: 0 } })],
      T0_MS,
      usage
    )
    assert.equal(usage.firstCallContextTokens, undefined)
  })

  test('an already-set prefix is never overwritten', async () => {
    const usage: ExecutorTokenUsage = { ...freshUsage(), firstCallContextTokens: 42_000 }
    await sumWith([sdkAssistant(T0_SECONDS + 10, { input: 9000, output: 10 })], T0_MS, usage)
    assert.equal(usage.firstCallContextTokens, 42_000)
  })

  test('a zero-prompt first message does not block a later real one', async () => {
    // The defect: the slot was claimed by whichever message came first, even at
    // prefix 0. Because `firstTs` then pins and nothing can displace it, the
    // `> 0` guard at the end wrote NULL for a turn whose prefix was right there
    // in the second message. opencode really does emit output-without-prompt
    // messages, so this was reachable, not theoretical.
    const usage = freshUsage()
    await sumWith(
      [
        sdkAssistant(T0_SECONDS + 10, { input: 0, output: 250, cache: { read: 0, write: 0 } }),
        sdkAssistant(T0_SECONDS + 20, { input: 1323, output: 47, cache: { read: 8192, write: 0 } })
      ],
      T0_MS,
      usage
    )
    assert.equal(usage.firstCallContextTokens, 1323 + 8192)
  })

  test('a fully-cached first message claims the slot (input 0, cache.read > 0)', async () => {
    // Matches the live event path's guard exactly: the candidate is
    // `input + cache.read`, not `input`, so a fully-cached first call is a real
    // prefix rather than a skipped one.
    const usage = freshUsage()
    await sumWith(
      [
        sdkAssistant(T0_SECONDS + 10, { input: 0, output: 50, cache: { read: 8192, write: 0 } }),
        sdkAssistant(T0_SECONDS + 20, { input: 900, output: 20, cache: { read: 8192, write: 0 } })
      ],
      T0_MS,
      usage
    )
    assert.equal(usage.firstCallContextTokens, 8192)
  })
})

// ── Characterization: the bug must not silently return ──

describe('sumAssistantTokensSince — legacy flat shape (the bug)', () => {
  test('flat {role, tokens} messages match nothing — pins the regression', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        {
          role: 'assistant',
          created: T0_SECONDS + 10,
          tokens: { input: 1000, output: 200, cache: { read: 0, write: 0 } }
        }
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 0, 'flat shape carries no info.role — nothing should be counted')
    assert.equal(usage.input, 0)
  })
})

// ── Timestamp handling ──

describe('sumAssistantTokensSince — sinceMs filtering', () => {
  test('messages created before sinceMs are excluded', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        sdkAssistant(T0_SECONDS - 600, { input: 9999, output: 9999 }),
        sdkAssistant(T0_SECONDS + 30, { input: 400, output: 40 })
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 1)
    assert.equal(usage.input, 400)
    assert.equal(usage.output, 40)
  })

  test('millisecond timestamps are accepted without a seconds conversion', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [sdkAssistant(0, { input: 300, output: 30 })].map((m) => {
        const info = (m as { info: Record<string, unknown> }).info
        info.time = { created: T0_MS + 5000 }
        return m
      }),
      T0_MS,
      usage
    )
    assert.equal(counted, 1)
    assert.equal(usage.input, 300)
  })

  test('ISO string timestamps are parsed', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        {
          info: {
            role: 'assistant',
            time: { created: new Date(T0_MS + 1000).toISOString() },
            tokens: { input: 250, output: 25, cache: { read: 0, write: 0 } }
          },
          parts: []
        }
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 1)
    assert.equal(usage.input, 250)
  })

  test('unparsable timestamps fail open — the message is counted', async () => {
    const usage = freshUsage()
    const counted = await sumWith(
      [
        {
          info: {
            role: 'assistant',
            time: { created: 'not-a-date' },
            tokens: { input: 800, output: 80, cache: { read: 0, write: 0 } }
          },
          parts: []
        }
      ],
      T0_MS,
      usage
    )
    assert.equal(counted, 1, 'under-counting a turn that ran is worse than a boundary message')
    assert.equal(usage.input, 800)
  })
})

// ── Failure modes ──

describe('sumAssistantTokensSince — failure modes', () => {
  test('returns 0 when no client is connected', async () => {
    const executor = new OpenCodeExecutor()
    const usage = freshUsage()
    const counted = await (
      executor as unknown as {
        sumAssistantTokensSince(s: string, since: number, u: ExecutorTokenUsage): Promise<number>
      }
    ).sumAssistantTokensSince('ses_test', T0_MS, usage)
    assert.equal(counted, 0)
    assert.equal(usage.input, 0)
  })

  test('returns 0 and leaves usage untouched when the fetch throws', async () => {
    const executor = new OpenCodeExecutor()
    ;(executor as unknown as { client: unknown }).client = {
      session: {
        messages: async () => {
          throw new Error('ECONNREFUSED')
        }
      }
    }
    const usage = freshUsage()
    const counted = await (
      executor as unknown as {
        sumAssistantTokensSince(s: string, since: number, u: ExecutorTokenUsage): Promise<number>
      }
    ).sumAssistantTokensSince('ses_test', T0_MS, usage)
    assert.equal(counted, 0)
    assert.equal(usage.input, 0)
  })

  test('empty message list returns 0', async () => {
    const usage = freshUsage()
    assert.equal(await sumWith([], T0_MS, usage), 0)
  })
})

// ── The zero-match warn must stay meaningful ──

describe('sumAssistantTokensSince — zero-match warn', () => {
  // The harness interleaves async tests, so the mock's warn ring is shared and
  // resetting it per test races. Each case therefore fetches a DISTINCT number
  // of messages and matches on the `(of N fetched)` fragment the warn already
  // prints — which scopes the assertion to its own scenario regardless of order.
  const fetchedFragment = (n: number): string => `(of ${n} fetched)`

  /** `n` assistant messages, all created before the turn window opened. */
  function history(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) =>
      sdkAssistant(T0_SECONDS - 600 + i, { input: 5000, output: 10 })
    )
  }

  test('does NOT warn for an aborted turn on a session with history', async () => {
    // The false positive the old `messages.length > 0` condition produced: a
    // turn that errored before its first assistant message, on a session that
    // already has plenty of older ones. Nothing is wrong here, and warning on it
    // every time is how a diagnostic gets tuned out.
    const counted = await sumWith(history(3), T0_MS, freshUsage())
    assert.equal(counted, 0)
    assert.deepEqual(
      logMock.__findRecords('warn', fetchedFragment(3)),
      [],
      'out-of-window history must not trip the shape warning'
    )
  })

  test('DOES warn when in-window assistant messages carried no tokens', async () => {
    // The real condition it exists for: this turn produced assistant messages
    // and not one of them carried usage — i.e. the SDK shape moved again.
    const counted = await sumWith(
      [
        ...history(3),
        sdkAssistant(T0_SECONDS + 10, { input: 0, output: 0, cache: { read: 0, write: 0 } })
      ],
      T0_MS,
      freshUsage()
    )
    assert.equal(counted, 0)
    const warned = logMock.__findRecords('warn', fetchedFragment(4))
    assert.equal(warned.length, 1, 'in-window messages without tokens must warn')
    assert.ok(
      warned[0].message.includes('1 in-window assistant'),
      `warn should report the in-window count, got: ${warned[0].message}`
    )
  })

  test('does NOT warn when the turn counted normally', async () => {
    const counted = await sumWith(
      [
        ...history(3),
        sdkAssistant(T0_SECONDS + 10, { input: 1000, output: 20 }),
        sdkAssistant(T0_SECONDS + 20, { input: 1100, output: 25 })
      ],
      T0_MS,
      freshUsage()
    )
    assert.equal(counted, 2)
    assert.deepEqual(logMock.__findRecords('warn', fetchedFragment(5)), [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

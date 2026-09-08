/**
 * provider-timeout-tiers.test.ts
 *
 * GAP-A — ordering invariants + consumer wiring smoke.
 *
 * 1. Ordering invariant per tier: noActivity < midTurnStall < taskWatchdog ≤
 *    sdkRead. The blueprint watchdog must sit ABOVE the executor's stall
 *    windows on the SAME provider or the watchdog fails slow-but-alive remote
 *    turns before the executor's own retry can fire.
 * 2. Local tier preserves the historical values (regression guard).
 * 3. Consumer wiring smoke: the config writer's provider options carry the
 *    tier values (sdkRead / chunkTimeout).
 * 4. P2 — `resolveStallWindowMs`: the dead-stall window, and the proof that
 *    shortening it cannot break the ordering invariant above.
 */

import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { getTimeoutTier } from '../provider-timeout-tiers'

// Consumer wiring smoke — the config writer's import chain pulls in the DB
// layer, which needs the full mock installed by the runner. Same lazy-require
// + skip pattern as blueprint-services-deep.test.ts: standalone runs skip the
// wiring check, runner runs exercise it.
type ProviderConfigResult = Record<
  string,
  {
    options?: { timeout?: number; chunkTimeout?: number }
  }
>
let buildProviderConfig:
  | ((
      provider: { providerId: string; modelId: string; baseUrl?: string; apiKey?: string },
      isLocal: boolean
    ) => ProviderConfigResult)
  | null = null
try {
  const mod = require('../opencode-config-writer')
  const writer = mod.openCodeConfigWriter as unknown as {
    buildProviderConfig: (
      provider: { providerId: string; modelId: string; baseUrl?: string; apiKey?: string },
      isLocal: boolean
    ) => ProviderConfigResult
  }
  buildProviderConfig = writer.buildProviderConfig.bind(writer)
} catch {
  buildProviderConfig = null
}

// P2 — same lazy-require + skip pattern: opencode-executor's import chain is
// heavy, so a standalone run skips these and the runner exercises them.
let resolveStallWindowMs:
  | ((input: {
      midTurnStallMs: number
      outstandingToolCall: boolean
      sawWriteActivity: boolean
    }) => number)
  | null = null
try {
  resolveStallWindowMs = require('../opencode-executor').resolveStallWindowMs
} catch {
  resolveStallWindowMs = null
}

describe('getTimeoutTier — ordering invariant', () => {
  for (const isRemote of [false, true]) {
    test(`${isRemote ? 'remote' : 'local'} tier: noActivity < midTurnStall < taskWatchdog ≤ sdkRead`, () => {
      const tier = getTimeoutTier(isRemote)
      assert.ok(
        tier.noActivityMs < tier.midTurnStallMs,
        `noActivity (${tier.noActivityMs}) must be < midTurnStall (${tier.midTurnStallMs})`
      )
      assert.ok(
        tier.midTurnStallMs < tier.taskWatchdogMs,
        `midTurnStall (${tier.midTurnStallMs}) must be < taskWatchdog (${tier.taskWatchdogMs})`
      )
      assert.ok(
        tier.taskWatchdogMs <= tier.sdkReadMs,
        `taskWatchdog (${tier.taskWatchdogMs}) must be ≤ sdkRead (${tier.sdkReadMs})`
      )
    })
  }
})

describe('getTimeoutTier — tier values', () => {
  test('local tier keeps the historical values (regression guard)', () => {
    const local = getTimeoutTier(false)
    assert.equal(local.sdkReadMs, 600_000)
    assert.equal(local.chunkTimeoutMs, 30_000)
    assert.equal(local.noActivityMs, 120_000)
    assert.equal(local.midTurnStallMs, 240_000)
    assert.equal(local.taskWatchdogMs, 300_000)
  })

  test('remote tier: watchdog (540s) sits above the stall retry (480s) and under the SDK read (600s)', () => {
    const remote = getTimeoutTier(true)
    assert.equal(remote.sdkReadMs, 600_000)
    assert.equal(remote.chunkTimeoutMs, 120_000)
    assert.equal(remote.noActivityMs, 300_000)
    assert.equal(remote.midTurnStallMs, 480_000)
    // GAP-A: the old flat 300s watchdog sat BELOW the 480s remote stall
    // window; 540s restores executor-retry-first ordering.
    assert.equal(remote.taskWatchdogMs, 540_000)
  })

  test('returned object is immutable — callers cannot corrupt the shared tier', () => {
    // Frozen: a caller assigning to a tier field throws in strict mode (this
    // test) and never affects subsequent calls.
    const a = getTimeoutTier(true)
    assert.deepEqual(a, getTimeoutTier(true))
    assert.throws(() => {
      'use strict'
      ;(a as unknown as Record<string, number>).taskWatchdogMs = 1
    }, TypeError)
    assert.equal(getTimeoutTier(true).taskWatchdogMs, 540_000)
  })
})

describe('provider-timeout-tiers — consumer wiring smoke', () => {
  test('opencode config writer provider options carry the tier sdkRead/chunkTimeout values', async () => {
    if (!buildProviderConfig) return // standalone run without the full DB mock
    for (const isLocal of [true, false]) {
      const providerId = isLocal ? 'ollama' : 'glm'
      const tier = getTimeoutTier(!isLocal)
      const providers: ProviderConfigResult = buildProviderConfig(
        {
          providerId,
          modelId: 'm1',
          baseUrl: isLocal ? 'http://localhost:11434' : 'https://api.example.com',
          ...(isLocal ? {} : { apiKey: 'k' })
        },
        isLocal
      )
      const options: { timeout?: number; chunkTimeout?: number } | undefined =
        providers[providerId]?.options
      assert.ok(options, `provider options missing for ${providerId}`)
      assert.equal(
        options.timeout,
        tier.sdkReadMs,
        `${providerId} timeout must match tier sdkReadMs`
      )
      assert.equal(
        options.chunkTimeout,
        tier.chunkTimeoutMs,
        `${providerId} chunkTimeout must match tier chunkTimeoutMs`
      )
    }
  })
})

// ═══ P2 — dead-stall window ═════════════════════════════════════════════

describe('resolveStallWindowMs — dead vs slow', () => {
  const FULL = 480_000

  test('nothing outstanding ⇒ the full mid-turn window (slow-but-alive is untouched)', () => {
    if (!resolveStallWindowMs) return
    assert.equal(
      resolveStallWindowMs({
        midTurnStallMs: FULL,
        outstandingToolCall: false,
        sawWriteActivity: false
      }),
      FULL
    )
  })

  test('outstanding tool call + zero writes ⇒ shortened (the observed hang shape)', () => {
    if (!resolveStallWindowMs) return
    assert.equal(
      resolveStallWindowMs({
        midTurnStallMs: FULL,
        outstandingToolCall: true,
        sawWriteActivity: false
      }),
      240_000
    )
  })

  test('a turn that has already written keeps the full window', () => {
    if (!resolveStallWindowMs) return
    // The exemption that protects a long `npm test` / build command: once the
    // turn has produced files, a slow tool is not evidence of death.
    assert.equal(
      resolveStallWindowMs({
        midTurnStallMs: FULL,
        outstandingToolCall: true,
        sawWriteActivity: true
      }),
      FULL
    )
  })

  test('the shortened window never inverts the tier ordering', () => {
    if (!resolveStallWindowMs) return
    // Shortening can only make the executor act EARLIER, so the watchdog still
    // fires last on both tiers. This is the invariant fb03fdff was written for.
    for (const isRemote of [false, true]) {
      const tier = getTimeoutTier(isRemote)
      const dead = resolveStallWindowMs({
        midTurnStallMs: tier.midTurnStallMs,
        outstandingToolCall: true,
        sawWriteActivity: false
      })
      assert.ok(dead <= tier.midTurnStallMs, 'dead-stall window must not exceed the full window')
      assert.ok(
        dead < tier.taskWatchdogMs,
        `dead-stall (${dead}) must stay under taskWatchdog (${tier.taskWatchdogMs})`
      )
    }
  })
})

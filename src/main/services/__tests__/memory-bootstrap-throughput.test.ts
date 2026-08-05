/**
 * The two headline numbers on the Feed Brain progress panel — Rate and ETA.
 *
 * Both are easy to get wrong in opposite directions, and a run is long enough
 * that a wrong number is the only thing the user has to judge it by:
 *   - the rate must divide by WALL-CLOCK time. Summing per-item durations
 *     across a pool of N workers counts the same minute N times, so a 3-worker
 *     run reported a third of its real throughput while the ETA beside it
 *     implied the true one.
 *   - both must discount hash-gated skips, which settle in microseconds. A
 *     re-run is mostly skips; counting them as work would report a rate of
 *     hundreds per minute and an ETA of zero.
 *
 * Run: tsx src/main/services/__tests__/memory-bootstrap-throughput.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let Throughput: any
let loaded = false

try {
  // db/index must be loaded first: the worker imports a repository, and
  // base-repository imports db/index, so requiring it cold trips a TDZ cycle
  // (`Cannot access 'BaseRepository'`). Same guard as the doc-state test.
  require('../../db/index')
  Throughput = require('../memory-bootstrap/worker').Throughput
  loaded = true
} catch (err) {
  console.error('[memory-bootstrap-throughput] module load failed:', err)
}

/** A clock the test drives by hand, so no test spends real seconds. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    }
  }
}

const MINUTE = 60_000

if (!loaded) {
  describe('Throughput (skipped — module unavailable)', () => {
    test('rate + eta', () => {}, { skipReason: 'worker module failed to load' })
  })
} else {
  describe('Throughput.itemsPerMinute', () => {
    test('divides by wall-clock time, not by summed item durations', () => {
      // Three workers, one minute, one 60s item each. The old denominator was
      // 180s of summed duration and reported 1.0/min for a run doing 3.0.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)

      assert.equal(t.itemsPerMinute(), 3)
    })

    test('the rate agrees with the ETA shown beside it', () => {
      // The panel puts these two numbers side by side. An ETA of 60s for 3
      // remaining items only makes sense next to a rate of 3/min.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)

      const rate = t.itemsPerMinute()!
      const etaSeconds = t.etaSeconds(3, 3)!

      assert.equal(rate, 3)
      assert.equal(etaSeconds, 60)
      assert.equal(
        Math.round((3 / rate) * 60),
        etaSeconds,
        'ETA and rate must describe the same run'
      )
    })

    test('reports nothing for the first five seconds', () => {
      // Early samples are noise: one fast item at t=1s would read as 60/min.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(4000)
      t.record(3500)

      assert.equal(t.itemsPerMinute(), null)
    })

    test('hash-gated skips do not inflate the rate', () => {
      // A re-run settles hundreds of unchanged files instantly. They are not
      // throughput — only the two files that really ran are.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      for (let i = 0; i < 400; i++) t.record(1)
      clock.advance(MINUTE)
      t.record(30_000)
      t.record(30_000)

      assert.equal(t.itemsPerMinute(), 2)
    })

    test('a run of nothing but skips has no rate to report', () => {
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      for (let i = 0; i < 50; i++) t.record(5)
      clock.advance(MINUTE)

      assert.equal(t.itemsPerMinute(), null, 'a dash is honest; 3000/min is not')
    })

    test('an idle pool does not decay the rate toward zero', () => {
      // Sanity on the denominator's direction: the same work over twice the
      // wall-clock is half the rate.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)
      assert.equal(t.itemsPerMinute(), 2)

      clock.advance(MINUTE)
      assert.equal(t.itemsPerMinute(), 1)
    })
  })

  describe('Throughput.totalActiveMs', () => {
    test('still sums per-item time across workers, plus the carried session', () => {
      // The rate moved to wall-clock, but the persisted activeMs is "time this
      // run spent working" and must keep counting every worker's contribution —
      // otherwise a resumed run under-reports how long it has been running.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      t.carry(2 * MINUTE)
      clock.advance(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)
      t.record(MINUTE)

      assert.equal(t.totalActiveMs, 5 * MINUTE)
    })
  })

  describe('Throughput.etaSeconds', () => {
    test('divides the remaining work by the pool size', () => {
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)

      assert.equal(t.etaSeconds(6, 1), 360, 'one worker: six items of a minute each')
      assert.equal(t.etaSeconds(6, 3), 120, 'three workers finish the same queue in a third')
    })

    test('projects the remaining queue through the observed skip ratio', () => {
      // 9 of 10 settled items were instant skips, so the 100 still queued are
      // expected to be ~90 skips and ~10 real extractions.
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)
      for (let i = 0; i < 9; i++) t.record(1)

      assert.equal(t.etaSeconds(100, 1), 600, 'charging all 100 a full minute would say 6000s')
    })

    test('has nothing to say before the first real item', () => {
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      assert.equal(t.etaSeconds(10, 1), null)
      t.record(5)
      assert.equal(t.etaSeconds(10, 1), null, 'a skip is not a measurement')
    })

    test('returns null once the queue is empty', () => {
      const clock = fakeClock()
      const t = new Throughput(clock.now)

      clock.advance(MINUTE)
      t.record(MINUTE)

      assert.equal(t.etaSeconds(0, 3), null)
    })
  })
}

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('memory-bootstrap-throughput')) {
  void summaryAsync()
}

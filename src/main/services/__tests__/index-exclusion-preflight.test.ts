/**
 * Tests for the index exclusion preflight.
 *
 * Two layers:
 *   1. classifyCandidate — pure decision matrix, no disk or git.
 *   2. runExclusionPreflight — real walk over a temp fixture tree, asserting
 *      the depth budget and that Tier-2 names are never auto-excluded.
 *
 * The regression these guard: a React Native workspace indexed every boost
 * header under apps/mobile/ios/Pods, while `libs/` full of first-party C#
 * must NOT be silently dropped by the same mechanism.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, describe } from './test-harness'
import {
  classifyCandidate,
  runExclusionPreflight,
  PREFLIGHT_MAX_DEPTH,
  PREFLIGHT_BUDGET_MS
} from '../index-exclusion-preflight.service'

// ── Helpers ──────────────────────────────────────────────────────────────

function stats(overrides: Partial<Parameters<typeof classifyCandidate>[0]['stats']> = {}): {
  fileCount: number
  totalBytes: number
  extCounts: Map<string, number>
  sourceFileCount: number
  binaryFileCount: number
  newestMtimeMs: number
  vendorMarkers: string[]
} {
  return {
    fileCount: 10,
    totalBytes: 1000,
    extCounts: new Map([['.cs', 10]]),
    sourceFileCount: 10,
    binaryFileCount: 0,
    newestMtimeMs: Date.now(),
    vendorMarkers: [],
    ...overrides
  }
}

// ── classifyCandidate ────────────────────────────────────────────────────

describe('classifyCandidate — decision matrix', () => {
  test('gitIgnored wins over everything → auto-exclude', () => {
    const r = classifyCandidate({
      dirName: 'libs',
      stats: stats(),
      gitIgnored: true,
      gitTracked: false,
      tier1: false
    })
    assert.equal(r.verdict, 'auto-exclude')
    assert.match(r.reason, /ignored by git/)
  })

  test('Tier-1 name → auto-exclude with no prompt', () => {
    const r = classifyCandidate({
      dirName: 'Pods',
      stats: stats(),
      gitIgnored: false,
      gitTracked: true,
      tier1: true
    })
    assert.equal(r.verdict, 'auto-exclude')
    assert.equal(r.defaultChecked, true)
  })

  test('Tier-2 + tracked + source, no vendor marker → confirm, UNCHECKED', () => {
    const r = classifyCandidate({
      dirName: 'libs',
      stats: stats({ sourceFileCount: 412 }),
      gitIgnored: false,
      gitTracked: true,
      tier1: false
    })
    assert.equal(r.verdict, 'needs-confirmation')
    assert.equal(r.defaultChecked, false)
    assert.ok(r.firstPartyHints.includes('committed to git'))
  })

  test('Tier-2 + vendor markers → confirm, CHECKED', () => {
    const r = classifyCandidate({
      dirName: 'external',
      stats: stats({ vendorMarkers: ['LICENSE', 'Alamofire.podspec'] }),
      gitIgnored: false,
      gitTracked: true,
      tier1: false
    })
    assert.equal(r.verdict, 'needs-confirmation')
    assert.equal(r.defaultChecked, true)
    assert.match(r.reason, /vendored third-party/)
  })

  test('binary-dominant directory → auto-exclude', () => {
    const r = classifyCandidate({
      dirName: 'runtime',
      stats: stats({ fileCount: 100, binaryFileCount: 90, sourceFileCount: 0 }),
      gitIgnored: false,
      gitTracked: false,
      tier1: false
    })
    assert.equal(r.verdict, 'auto-exclude')
    assert.match(r.reason, /binaries only/)
  })

  test('exactly 80% binaries is NOT enough to auto-exclude', () => {
    const r = classifyCandidate({
      dirName: 'runtime',
      stats: stats({ fileCount: 100, binaryFileCount: 80, sourceFileCount: 20 }),
      gitIgnored: false,
      gitTracked: false,
      tier1: false
    })
    assert.equal(r.verdict, 'keep')
  })

  test('ordinary first-party directory → keep', () => {
    const r = classifyCandidate({
      dirName: 'services',
      stats: stats(),
      gitIgnored: false,
      gitTracked: true,
      tier1: false
    })
    assert.equal(r.verdict, 'keep')
  })
})

// ── runExclusionPreflight ────────────────────────────────────────────────

describe('runExclusionPreflight — fixture walk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atelier-preflight-'))

  const writeFile = (rel: string, content = 'x'): void => {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf-8')
  }

  // Tier 1 — the reported bug
  writeFile('apps/mobile/ios/Pods/ReactNativeDependencies/Headers/boost/type_traits.hpp')
  writeFile('apps/mobile/ios/Pods/Alamofire/Source/Alamofire.swift')
  // Tier 2 — first-party source, must require confirmation
  writeFile('libs/Domain/Order.cs')
  writeFile('libs/Domain/Customer.cs')
  // Tier 2 — vendored, has markers
  writeFile('external/LICENSE')
  writeFile('external/Vendor.podspec')
  writeFile('external/vendor.swift')
  // First-party, must never be reported
  writeFile('src/services/order.service.ts')
  // Beyond the depth budget
  writeFile('d1/d2/d3/d4/d5/libs/deep.ts')
  writeFile('d1/d2/d3/d4/d5/d6/libs/too-deep.ts')

  const result = runExclusionPreflight(root)
  const byPath = new Map(result.candidates.map((c) => [c.relPath, c]))

  test('completes within the documented budget', () => {
    assert.ok(
      result.durationMs <= PREFLIGHT_BUDGET_MS * 2,
      `took ${result.durationMs}ms, budget is ${PREFLIGHT_BUDGET_MS}ms`
    )
  })

  test('finds the Pods tree and marks it auto-exclude', () => {
    const pods = byPath.get('apps/mobile/ios/Pods')
    assert.ok(pods, `expected Pods candidate, got: ${[...byPath.keys()].join(', ')}`)
    assert.equal(pods.verdict, 'auto-exclude')
    assert.equal(pods.fileCount, 2)
  })

  test('first-party libs/ needs confirmation and starts unchecked', () => {
    const libs = byPath.get('libs')
    assert.ok(libs)
    assert.equal(libs.verdict, 'needs-confirmation')
    assert.equal(libs.defaultChecked, false)
    assert.equal(libs.suggestedRule, '/libs/')
  })

  test('vendored external/ needs confirmation but starts checked', () => {
    const ext = byPath.get('external')
    assert.ok(ext)
    assert.equal(ext.verdict, 'needs-confirmation')
    assert.equal(ext.defaultChecked, true)
    assert.ok(ext.vendorMarkers.length >= 2)
  })

  test('ordinary source directories are never reported', () => {
    assert.equal(byPath.has('src'), false)
    assert.equal(byPath.has('src/services'), false)
  })

  test('reports top extensions for the UI', () => {
    const libs = byPath.get('libs')!
    assert.deepEqual(libs.extensions, [{ ext: '.cs', count: 2 }])
  })

  test(`respects the depth budget of ${PREFLIGHT_MAX_DEPTH}`, () => {
    assert.ok(byPath.has('d1/d2/d3/d4/d5/libs'), 'level-6 candidate should be found')
    assert.equal(byPath.has('d1/d2/d3/d4/d5/d6/libs'), false, 'level-7 candidate is out of budget')
    assert.equal(result.truncated, true)
  })

  test('cleanup', () => {
    rmSync(root, { recursive: true, force: true })
    assert.ok(true)
  })
})

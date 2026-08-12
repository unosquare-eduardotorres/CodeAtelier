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
  countMinifiedPairs,
  findVersionedSiblings,
  runExclusionPreflight,
  PREFLIGHT_MAX_DEPTH,
  PREFLIGHT_BUDGET_MS
} from '../index-exclusion-preflight.service'

// ── Helpers ──────────────────────────────────────────────────────────────

type Stats = Parameters<typeof classifyCandidate>[0]['stats']

function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    fileCount: 10,
    totalBytes: 1000,
    extCounts: new Map([['.cs', 10]]),
    sourceFileCount: 10,
    binaryFileCount: 0,
    newestMtimeMs: Date.now(),
    vendorMarkers: [],
    versionedSiblings: [],
    minifiedPairs: 0,
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

  test('Tier-2 + versioned sibling copies → confirm, CHECKED', () => {
    const r = classifyCandidate({
      dirName: 'lib',
      stats: stats({ versionedSiblings: [{ stem: 'angularjs', count: 3 }], sourceFileCount: 900 }),
      gitIgnored: false,
      gitTracked: true,
      tier1: false
    })
    assert.equal(r.verdict, 'needs-confirmation')
    assert.equal(r.defaultChecked, true, 'three versioned copies is near-conclusive vendoring')
    assert.match(r.reason, /3 versioned copies of the same library \(angularjs\)/)
  })

  test('Tier-2 + minified/source pairs → confirm, CHECKED', () => {
    const r = classifyCandidate({
      dirName: 'lib',
      stats: stats({ minifiedPairs: 4, sourceFileCount: 20 }),
      gitIgnored: false,
      gitTracked: true,
      tier1: false
    })
    assert.equal(r.verdict, 'needs-confirmation')
    assert.equal(r.defaultChecked, true)
    assert.match(r.reason, /4 minified\/source file pair/)
  })

  test('new vendor signals never override a Tier-1 or gitIgnored verdict', () => {
    const vendored = stats({ versionedSiblings: [{ stem: 'angularjs', count: 3 }] })
    assert.equal(
      classifyCandidate({
        dirName: 'lib',
        stats: vendored,
        gitIgnored: true,
        gitTracked: false,
        tier1: false
      }).verdict,
      'auto-exclude'
    )
    assert.equal(
      classifyCandidate({
        dirName: 'obj',
        stats: vendored,
        gitIgnored: false,
        gitTracked: false,
        tier1: true
      }).verdict,
      'auto-exclude'
    )
  })

  test('vendor signals do not promote a non-Tier-2 directory', () => {
    const r = classifyCandidate({
      dirName: 'services',
      stats: stats({ versionedSiblings: [{ stem: 'angularjs', count: 3 }], minifiedPairs: 9 }),
      gitIgnored: false,
      gitTracked: true,
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

// ── Vendor signal primitives ──────────────────────────────────

describe('findVersionedSiblings', () => {
  test('groups versioned copies of one library', () => {
    const groups = findVersionedSiblings([
      'angularjs-1.2.0',
      'angularjs-1.2.25',
      'angularjs-1.2.0-rc.3',
      'my-feature'
    ])
    assert.deepEqual(groups, [{ stem: 'angularjs', count: 3 }])
  })

  test('accepts underscore, dot and v-prefixed separators', () => {
    assert.deepEqual(findVersionedSiblings(['jquery_v1.11.0', 'jquery_v3.6.0']), [
      { stem: 'jquery', count: 2 }
    ])
    assert.deepEqual(findVersionedSiblings(['bootstrap.3.4.1', 'bootstrap.5.3.2']), [
      { stem: 'bootstrap', count: 2 }
    ])
  })

  test('a single versioned directory is not evidence', () => {
    assert.deepEqual(findVersionedSiblings(['angularjs-1.2.25', 'src', 'utils']), [])
  })

  test('unversioned siblings never group', () => {
    assert.deepEqual(findVersionedSiblings(['Domain', 'Infrastructure', 'Api']), [])
  })

  test('a bare major version is not a version — needs major.minor', () => {
    assert.deepEqual(findVersionedSiblings(['api-v1', 'api-v2']), [])
  })
})

describe('countMinifiedPairs', () => {
  test('counts a source file sitting next to its minified build', () => {
    assert.equal(countMinifiedPairs(['angular.js', 'angular.min.js', 'app.css', 'app.min.css']), 2)
  })

  test('a minified file with no source sibling is not a pair', () => {
    assert.equal(countMinifiedPairs(['angular.min.js', 'app.ts']), 0)
  })

  test('matching is case-insensitive for Windows checkouts', () => {
    assert.equal(countMinifiedPairs(['Angular.js', 'angular.MIN.js']), 1)
  })

  test('ordinary source directories yield nothing', () => {
    assert.equal(countMinifiedPairs(['order.service.ts', 'order.test.ts']), 0)
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
  // Tier 2 — vendored by versioned siblings, no markers of any kind
  writeFile('plugins/angularjs-1.2.0/angular.js')
  writeFile('plugins/angularjs-1.2.25/angular.js')
  writeFile('plugins/angularjs-1.2.0-rc.3/angular.js')
  // Tier 2 — vendored by minified distribution artefacts
  writeFile('modules/jquery.js')
  writeFile('modules/jquery.min.js')
  // Tier 2 — vendor marker sits one level down, not at the candidate root
  writeFile('deps/somelib/LICENSE')
  writeFile('deps/somelib/somelib.js')
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

  test('detects versioned sibling copies and starts them checked', () => {
    const plugins = byPath.get('plugins')
    assert.ok(plugins, `expected plugins candidate, got: ${[...byPath.keys()].join(', ')}`)
    assert.equal(plugins.verdict, 'needs-confirmation')
    assert.equal(plugins.defaultChecked, true)
    assert.match(plugins.reason, /3 versioned copies of the same library \(angularjs\)/)
  })

  test('detects minified/source pairs and starts them checked', () => {
    const mods = byPath.get('modules')
    assert.ok(mods)
    assert.equal(mods.verdict, 'needs-confirmation')
    assert.equal(mods.defaultChecked, true)
    assert.match(mods.reason, /minified\/source file pair/)
  })

  test('finds vendor markers one level below the candidate root', () => {
    const deps = byPath.get('deps')
    assert.ok(deps)
    assert.equal(deps.defaultChecked, true)
    assert.deepEqual(deps.vendorMarkers, ['somelib/LICENSE'])
  })

  test('cleanup', () => {
    rmSync(root, { recursive: true, force: true })
    assert.ok(true)
  })
})

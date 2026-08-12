/**
 * blueprint-task-verification.test.ts
 *
 * Tests for deterministic file verification of build tasks.
 * Covers: verifyTaskFileClaims, scanCompletedTaskFiles, applyDeterministicFileCheck
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, describe, summaryAsync } from './test-harness'
import {
  verifyTaskFileClaims,
  scanCompletedTaskFiles,
  applyDeterministicFileCheck
} from '../blueprint-task-verification'
import { EVIDENCE_ONLY_RX } from '../blueprint-build.service'
import { RERUN_VERIFY_RX, GENERIC_REMEDIATION_TASK_DESC } from '../blueprint-verify.service'

// ── Temp workspace helper ──

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'bp-verify-test-'))
}

function cleanupTmpWorkspace(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// verifyTaskFileClaims
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyTaskFileClaims — all claimed files exist', () => {
  test('returns ok: true when all claimed created files exist on disk', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')
      writeFileSync(join(wp, 'src/b.ts'), 'content')

      const result = verifyTaskFileClaims(wp, { filesCreated: ['src/a.ts', 'src/b.ts'] }, [
        'src/a.ts',
        'src/b.ts'
      ])
      assert.equal(result.ok, true)
      assert.equal(result.missingClaimed.length, 0)
      assert.equal(result.unverifiable, false)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — one claimed created file missing', () => {
  test('returns ok: false with missingClaimed populated', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')
      // src/b.ts intentionally NOT created

      const result = verifyTaskFileClaims(wp, { filesCreated: ['src/a.ts', 'src/b.ts'] }, [
        'src/a.ts',
        'src/b.ts'
      ])
      assert.equal(result.ok, false)
      assert.deepEqual(result.missingClaimed, ['src/b.ts'])
      assert.equal(result.unverifiable, false)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — claimed modified file missing', () => {
  test('returns ok: false when filesModified entry is absent', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/existing.ts'), 'content')
      // src/modified.ts intentionally NOT created

      const result = verifyTaskFileClaims(
        wp,
        { filesCreated: ['src/existing.ts'], filesModified: ['src/modified.ts'] },
        []
      )
      assert.equal(result.ok, false)
      assert.deepEqual(result.missingClaimed, ['src/modified.ts'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — R029 signature: no completion + zero planned files on disk', () => {
  test('returns ok: false when no completion and none of planned files exist', () => {
    const wp = makeTmpWorkspace()
    try {
      // No files created on disk
      const result = verifyTaskFileClaims(wp, null, ['src/a.ts', 'src/b.ts'])
      assert.equal(result.ok, false)
      assert.equal(result.missingClaimed.length, 0)
      assert.deepEqual(result.missingPlanned, ['src/a.ts', 'src/b.ts'])
      assert.equal(result.unverifiable, false)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — no completion block + planned files exist (lenient path)', () => {
  test('returns ok: true when agent worked but forgot the completion block', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')

      const result = verifyTaskFileClaims(wp, null, ['src/a.ts', 'src/b.ts'])
      assert.equal(result.ok, true)
      assert.equal(result.missingClaimed.length, 0)
      // b.ts is missing from planned but that's non-fatal
      assert.deepEqual(result.missingPlanned, ['src/b.ts'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — path traversal treated as missing', () => {
  test('../../etc/passwd counts as missing', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = verifyTaskFileClaims(wp, { filesCreated: ['../../etc/passwd'] }, [])
      assert.equal(result.ok, false)
      assert.deepEqual(result.missingClaimed, ['../../etc/passwd'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — no claims + no planned files (unverifiable)', () => {
  test('returns ok: true, unverifiable: true', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = verifyTaskFileClaims(
        wp,
        { summary: 'All done' }, // completion block with no file claims
        []
      )
      assert.equal(result.ok, true)
      assert.equal(result.unverifiable, true)
      assert.equal(result.missingClaimed.length, 0)
      assert.equal(result.missingPlanned.length, 0)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — empty completion (null) + no planned files', () => {
  test('returns ok: true, unverifiable: true', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = verifyTaskFileClaims(wp, null, [])
      assert.equal(result.ok, true)
      assert.equal(result.unverifiable, true)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// scanCompletedTaskFiles
// ═══════════════════════════════════════════════════════════════════════════

describe('scanCompletedTaskFiles — legacy (no completionJson)', () => {
  test('returns empty map when all planned files exist', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')

      const result = scanCompletedTaskFiles(wp, [
        { taskId: 'T001', status: 'complete', filePathsJson: ['src/a.ts'] }
      ])
      assert.equal(result.size, 0)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })

  test('returns missingClaimed for complete tasks with absent planned files (backward compat)', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = scanCompletedTaskFiles(wp, [
        { taskId: 'T001', status: 'complete', filePathsJson: ['src/missing.ts'] },
        { taskId: 'T002', status: 'complete', filePathsJson: ['src/also-missing.ts'] },
        { taskId: 'T003', status: 'failed', filePathsJson: ['src/irrelevant.ts'] } // skipped — not complete
      ])
      assert.equal(result.size, 2)
      assert.deepEqual(result.get('T001')!.missingClaimed, ['src/missing.ts'])
      assert.deepEqual(result.get('T001')!.driftFiles, [])
      assert.deepEqual(result.get('T002')!.missingClaimed, ['src/also-missing.ts'])
      assert.equal(result.has('T003'), false)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })

  test('skips tasks with empty filePathsJson', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = scanCompletedTaskFiles(wp, [
        { taskId: 'T001', status: 'complete', filePathsJson: [] }
      ])
      assert.equal(result.size, 0)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('scanCompletedTaskFiles — with completionJson', () => {
  test('all claimed files present → driftFiles only for unclaimed planned files', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')
      writeFileSync(join(wp, 'src/b.ts'), 'content')

      const result = scanCompletedTaskFiles(wp, [
        {
          taskId: 'T001',
          status: 'complete',
          filePathsJson: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          completionJson: { filesCreated: ['src/a.ts', 'src/b.ts'], filesModified: [] }
        }
      ])
      assert.equal(result.size, 1)
      assert.deepEqual(result.get('T001')!.missingClaimed, [])
      assert.deepEqual(result.get('T001')!.driftFiles, ['src/c.ts'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })

  test('claimed file missing on disk → missingClaimed populated', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')

      const result = scanCompletedTaskFiles(wp, [
        {
          taskId: 'T001',
          status: 'complete',
          filePathsJson: ['src/a.ts', 'src/b.ts'],
          completionJson: { filesCreated: ['src/a.ts', 'src/b.ts'], filesModified: [] }
        }
      ])
      assert.equal(result.size, 1)
      assert.deepEqual(result.get('T001')!.missingClaimed, ['src/b.ts'])
      assert.deepEqual(result.get('T001')!.driftFiles, [])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })

  test('planned-but-not-claimed file missing → driftFiles only', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/a.ts'), 'content')

      const result = scanCompletedTaskFiles(wp, [
        {
          taskId: 'T001',
          status: 'complete',
          filePathsJson: ['src/a.ts', 'src/b.ts'],
          completionJson: { filesCreated: ['src/a.ts'], filesModified: [] }
        }
      ])
      assert.equal(result.size, 1)
      assert.deepEqual(result.get('T001')!.missingClaimed, [])
      assert.deepEqual(result.get('T001')!.driftFiles, ['src/b.ts'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })

  test('null completionJson falls back to filePathsJson checking', () => {
    const wp = makeTmpWorkspace()
    try {
      const result = scanCompletedTaskFiles(wp, [
        {
          taskId: 'T001',
          status: 'complete',
          filePathsJson: ['src/missing.ts'],
          completionJson: null
        }
      ])
      assert.equal(result.size, 1)
      assert.deepEqual(result.get('T001')!.missingClaimed, ['src/missing.ts'])
      assert.deepEqual(result.get('T001')!.driftFiles, [])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// applyDeterministicFileCheck
// ═══════════════════════════════════════════════════════════════════════════

describe('applyDeterministicFileCheck — missingClaimed + passed → gaps_found', () => {
  test('force-downgrades passed to gaps_found when claimed files are missing', () => {
    const completion: Record<string, unknown> = {
      overallStatus: 'passed',
      findings: []
    }
    const missingByTask = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>([
      ['T001', { missingClaimed: ['src/missing.ts'], driftFiles: [] }],
      ['T002', { missingClaimed: ['src/a.ts', 'src/b.ts'], driftFiles: [] }]
    ])

    const result = applyDeterministicFileCheck(completion, missingByTask)
    assert.ok(result)
    assert.equal(result!.overallStatus, 'gaps_found')
    assert.ok(Array.isArray(result!.findings))
    const findings = result!.findings as Array<Record<string, unknown>>
    assert.equal(findings.length, 1)
    assert.equal(findings[0].source, 'deterministic-disk-check')
  })
})

describe('applyDeterministicFileCheck — gaps_found stays gaps_found', () => {
  test('preserves gaps_found and adds deterministic findings', () => {
    const completion: Record<string, unknown> = {
      overallStatus: 'gaps_found',
      findings: [{ existing: true }]
    }
    const missingByTask = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>([
      ['T001', { missingClaimed: ['src/missing.ts'], driftFiles: [] }]
    ])

    const result = applyDeterministicFileCheck(completion, missingByTask)
    assert.ok(result)
    assert.equal(result!.overallStatus, 'gaps_found')
    const findings = result!.findings as Array<Record<string, unknown>>
    assert.equal(findings.length, 2) // 1 existing + 1 deterministic
    assert.equal(findings[0].existing, true) // original preserved
    assert.equal(findings[1].source, 'deterministic-disk-check')
  })
})

describe('applyDeterministicFileCheck — empty map → untouched', () => {
  test('returns completion unchanged when no missing files', () => {
    const completion: Record<string, unknown> = {
      overallStatus: 'passed',
      findings: []
    }
    const result = applyDeterministicFileCheck(completion, new Map())
    assert.equal(result, completion) // identity — same reference
  })
})

describe('applyDeterministicFileCheck — undefined completion', () => {
  test('returns undefined when completion is undefined', () => {
    const missingByTask = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>([
      ['T001', { missingClaimed: ['src/missing.ts'], driftFiles: [] }]
    ])
    const result = applyDeterministicFileCheck(undefined, missingByTask)
    assert.equal(result, undefined)
  })
})

// FIX-5a: human_needed + missing files → gaps_found
describe('applyDeterministicFileCheck — human_needed + missing files → gaps_found', () => {
  test('human_needed IS downgraded to gaps_found when claimed files are missing', () => {
    const completion: Record<string, unknown> = {
      overallStatus: 'human_needed',
      findings: []
    }
    const missingByTask = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>([
      ['T001', { missingClaimed: ['src/missing.ts'], driftFiles: [] }]
    ])
    const result = applyDeterministicFileCheck(completion, missingByTask)
    assert.ok(result)
    assert.equal(result!.overallStatus, 'gaps_found')
    const findings = result!.findings as Array<Record<string, unknown>>
    assert.equal(findings.length, 1)
    assert.equal(findings[0].source, 'deterministic-disk-check')
  })
})

describe('applyDeterministicFileCheck — drift-only does NOT downgrade status', () => {
  test('passed stays passed when only driftFiles present (no missingClaimed)', () => {
    const completion: Record<string, unknown> = {
      overallStatus: 'passed',
      findings: []
    }
    const missingByTask = new Map<string, { missingClaimed: string[]; driftFiles: string[] }>([
      ['T001', { missingClaimed: [], driftFiles: ['src/planned-but-skipped.ts'] }]
    ])
    const result = applyDeterministicFileCheck(completion, missingByTask)
    assert.ok(result)
    assert.equal(result!.overallStatus, 'passed') // NOT downgraded
    const findings = result!.findings as Array<Record<string, unknown>>
    assert.equal(findings.length, 1)
    assert.equal(findings[0].source, 'deterministic-disk-check-drift')
    assert.equal(findings[0].severity, 'info')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// FIX-3: mtime freshness tests
// ═══════════════════════════════════════════════════════════════════════════

describe('verifyTaskFileClaims — stale-mtime claimed file → fail', () => {
  test('claimed file exists but is stale (mtime before taskStartedAt) → ok: false, staleClaimed populated', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/old.ts'), 'stale content')
      // Set mtime to 10 minutes ago
      const { utimesSync } = require('node:fs')
      const tenMinAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(join(wp, 'src/old.ts'), tenMinAgo, tenMinAgo)

      const taskStartedAt = Date.now()
      const result = verifyTaskFileClaims(
        wp,
        { filesCreated: ['src/old.ts'] },
        ['src/old.ts'],
        taskStartedAt
      )
      assert.equal(result.ok, false)
      assert.equal(result.missingClaimed.length, 0)
      assert.deepEqual(result.staleClaimed, ['src/old.ts'])
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — fresh file passes with taskStartedAt', () => {
  test('claimed file with recent mtime passes freshness check', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      // Write file NOW — its mtime is fresh
      writeFileSync(join(wp, 'src/fresh.ts'), 'new content')

      // taskStartedAt is slightly in the past
      const taskStartedAt = Date.now() - 5000
      const result = verifyTaskFileClaims(
        wp,
        { filesCreated: ['src/fresh.ts'] },
        ['src/fresh.ts'],
        taskStartedAt
      )
      assert.equal(result.ok, true)
      assert.equal(result.staleClaimed.length, 0)
      assert.equal(result.missingClaimed.length, 0)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — taskStartedAt omitted → freshness skipped', () => {
  test('stale file passes when taskStartedAt is not provided', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/old.ts'), 'stale content')
      // Set mtime to 10 minutes ago
      const { utimesSync } = require('node:fs')
      const tenMinAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(join(wp, 'src/old.ts'), tenMinAgo, tenMinAgo)

      // No taskStartedAt → freshness check skipped
      const result = verifyTaskFileClaims(wp, { filesCreated: ['src/old.ts'] }, ['src/old.ts'])
      assert.equal(result.ok, true)
      assert.equal(result.staleClaimed.length, 0)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('verifyTaskFileClaims — lenient path with taskStartedAt requires fresh planned file', () => {
  test('no completion + stale planned files + taskStartedAt → ok: false', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/old.ts'), 'stale content')
      const { utimesSync } = require('node:fs')
      const tenMinAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(join(wp, 'src/old.ts'), tenMinAgo, tenMinAgo)

      const taskStartedAt = Date.now()
      const result = verifyTaskFileClaims(wp, null, ['src/old.ts'], taskStartedAt)
      assert.equal(result.ok, false)
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// BP-VERIFY-UNVERIFIABLE-01 (R007): re-rooting + "cannot check" ≠ "missing"
// ══════════════════════════════════════════════════════════════════════

describe('verifyTaskFileClaims — planned path in the main checkout re-roots onto the worktree', () => {
  test('absolute main-checkout path is confirmed against the execution root', () => {
    const main = makeTmpWorkspace()
    const worktree = makeTmpWorkspace()
    try {
      // BUILD wrote the file in its worktree; the plan named it in the main checkout.
      mkdirSync(join(worktree, 'src'), { recursive: true })
      writeFileSync(join(worktree, 'src/a.ts'), 'content')

      const result = verifyTaskFileClaims(worktree, null, [join(main, 'src/a.ts')], undefined, main)
      assert.equal(result.ok, true)
      assert.deepEqual(result.missingPlanned, [])
      assert.deepEqual(result.unverifiablePlanned, [])
      assert.equal(result.unverifiable, false)
    } finally {
      cleanupTmpWorkspace(main)
      cleanupTmpWorkspace(worktree)
    }
  })

  test('claimed main-checkout path re-roots too — no false missingClaimed', () => {
    const main = makeTmpWorkspace()
    const worktree = makeTmpWorkspace()
    try {
      mkdirSync(join(worktree, 'src'), { recursive: true })
      writeFileSync(join(worktree, 'src/a.ts'), 'content')

      const result = verifyTaskFileClaims(
        worktree,
        { filesCreated: [join(main, 'src/a.ts')] },
        [],
        undefined,
        main
      )
      assert.equal(result.ok, true)
      assert.deepEqual(result.missingClaimed, [])
    } finally {
      cleanupTmpWorkspace(main)
      cleanupTmpWorkspace(worktree)
    }
  })
})

describe('verifyTaskFileClaims — path under neither root is unverifiable, never missing', () => {
  test('out-of-root planned path lands in unverifiablePlanned and not missingPlanned', () => {
    const main = makeTmpWorkspace()
    const worktree = makeTmpWorkspace()
    try {
      mkdirSync(join(worktree, 'src'), { recursive: true })
      writeFileSync(join(worktree, 'src/a.ts'), 'content')

      const stray = join(tmpdir(), 'bp-not-a-root-xyz', 'src/stray.ts')
      const result = verifyTaskFileClaims(worktree, null, ['src/a.ts', stray], undefined, main)
      assert.equal(result.ok, true)
      assert.deepEqual(result.unverifiablePlanned, [stray])
      assert.equal(result.missingPlanned.includes(stray), false)
    } finally {
      cleanupTmpWorkspace(main)
      cleanupTmpWorkspace(worktree)
    }
  })

  test('traversal path is still refused (not silently re-rooted)', () => {
    const main = makeTmpWorkspace()
    const worktree = makeTmpWorkspace()
    try {
      const result = verifyTaskFileClaims(
        worktree,
        { filesCreated: ['../../etc/passwd'] },
        [],
        undefined,
        main
      )
      assert.equal(result.ok, false)
      assert.deepEqual(result.missingClaimed, ['../../etc/passwd'])
    } finally {
      cleanupTmpWorkspace(main)
      cleanupTmpWorkspace(worktree)
    }
  })
})

describe('verifyTaskFileClaims — R007 regression: all planned paths unverifiable + no completion', () => {
  test('returns ok: true, unverifiable: true instead of hard-failing forever', () => {
    const worktree = makeTmpWorkspace()
    try {
      const stray = join(tmpdir(), 'bp-not-a-root-xyz', 'src/stray.ts')
      const result = verifyTaskFileClaims(worktree, null, [stray], Date.now())
      assert.equal(result.ok, true)
      assert.equal(result.unverifiable, true)
      assert.deepEqual(result.unverifiablePlanned, [stray])
      assert.deepEqual(result.missingPlanned, [])
    } finally {
      cleanupTmpWorkspace(worktree)
    }
  })

  test('one checkable path that is genuinely absent still hard-fails (R029 detector intact)', () => {
    const worktree = makeTmpWorkspace()
    try {
      const stray = join(tmpdir(), 'bp-not-a-root-xyz', 'src/stray.ts')
      const result = verifyTaskFileClaims(worktree, null, [stray, 'src/absent.ts'], Date.now())
      assert.equal(result.ok, false)
      assert.equal(result.unverifiable, false)
      assert.deepEqual(result.missingPlanned, ['src/absent.ts'])
      assert.deepEqual(result.unverifiablePlanned, [stray])
    } finally {
      cleanupTmpWorkspace(worktree)
    }
  })
})

describe('scanCompletedTaskFiles — re-rooting and unverifiable paths', () => {
  test('re-rootable planned path is not reported as missingClaimed (legacy branch)', () => {
    const main = makeTmpWorkspace()
    const worktree = makeTmpWorkspace()
    try {
      mkdirSync(join(worktree, 'src'), { recursive: true })
      writeFileSync(join(worktree, 'src/a.ts'), 'content')

      const result = scanCompletedTaskFiles(
        worktree,
        [{ taskId: 'T001', status: 'complete', filePathsJson: [join(main, 'src/a.ts')] }],
        main
      )
      assert.equal(result.size, 0)
    } finally {
      cleanupTmpWorkspace(main)
      cleanupTmpWorkspace(worktree)
    }
  })

  test('out-of-root planned path is skipped rather than downgrading the task', () => {
    const worktree = makeTmpWorkspace()
    try {
      const stray = join(tmpdir(), 'bp-not-a-root-xyz', 'src/stray.ts')
      const result = scanCompletedTaskFiles(worktree, [
        { taskId: 'T001', status: 'complete', filePathsJson: [stray] }
      ])
      assert.equal(result.size, 0)
    } finally {
      cleanupTmpWorkspace(worktree)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BP-EVIDENCE-ONLY-SOFTPASS: Evidence-only task soft-pass regex tests
// ═══════════════════════════════════════════════════════════════════════

// GAP-5 FIX: Import regexes from source modules instead of re-declaring.
// EVIDENCE_ONLY_RX from blueprint-build.service.ts
// RERUN_VERIFY_RX from blueprint-verify.service.ts

describe('EVIDENCE_ONLY_RX — matches evidence/verification task descriptions', () => {
  test('matches "Re-run the full verify pass with evidence: eslint, tsc, vitest"', () => {
    assert.ok(
      EVIDENCE_ONLY_RX.test(
        'Re-run the full verify pass with evidence: eslint, tsc, vitest, complexity, dead code'
      )
    )
  })

  // GAP-4: bare "Run" (without "Re-") no longer matches — accepted tradeoff
  test('does NOT match bare "Run verification with all evidence" (GAP-4)', () => {
    assert.equal(EVIDENCE_ONLY_RX.test('Run verification with all evidence'), false)
  })

  test('matches "Re-run verification with all evidence"', () => {
    assert.ok(EVIDENCE_ONLY_RX.test('Re-run verification with all evidence'))
  })

  test('matches "re-run verify pass"', () => {
    assert.ok(EVIDENCE_ONLY_RX.test('re-run verify pass'))
  })

  test('matches "verification pass with evidence"', () => {
    assert.ok(EVIDENCE_ONLY_RX.test('verification pass with evidence'))
  })

  test('matches "verify evidence for eslint"', () => {
    assert.ok(EVIDENCE_ONLY_RX.test('evidence from eslint checks'))
  })

  test('does NOT match normal code task: "Add error handling to auth service"', () => {
    assert.equal(EVIDENCE_ONLY_RX.test('Add error handling to auth service'), false)
  })

  test('does NOT match "Fix TypeScript type errors in user.ts"', () => {
    assert.equal(EVIDENCE_ONLY_RX.test('Fix TypeScript type errors in user.ts'), false)
  })

  test('does NOT match "Implement user registration endpoint"', () => {
    assert.equal(EVIDENCE_ONLY_RX.test('Implement user registration endpoint'), false)
  })
})

describe('RERUN_VERIFY_RX — matches circular re-run-verify task descriptions', () => {
  test('matches "Re-run the full verify pass with evidence"', () => {
    assert.ok(
      RERUN_VERIFY_RX.test(
        'Re-run the full verify pass with evidence: eslint, tsc, vitest, complexity, dead code'
      )
    )
  })

  test('matches "re-run verification"', () => {
    assert.ok(RERUN_VERIFY_RX.test('re-run verification'))
  })

  test('matches "verify pass"', () => {
    assert.ok(RERUN_VERIFY_RX.test('verify pass'))
  })

  test('matches "verification evidence"', () => {
    assert.ok(RERUN_VERIFY_RX.test('verification evidence'))
  })

  test('does NOT match "Verify user login flow works"', () => {
    // "Verify" without "pass" or "evidence" after it should not match
    assert.equal(RERUN_VERIFY_RX.test('Verify user login flow works'), false)
  })

  test('does NOT match "Add unit test for verification utility"', () => {
    assert.equal(RERUN_VERIFY_RX.test('Add unit test for verification utility'), false)
  })
})

describe('evidence-only soft-pass — stale-only + evidence description → should soft-pass', () => {
  test('stale-only verification + evidence task description → qualifies for soft-pass', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/old.ts'), 'stale content')
      const { utimesSync } = require('node:fs')
      const tenMinAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(join(wp, 'src/old.ts'), tenMinAgo, tenMinAgo)

      const taskStartedAt = Date.now()
      const result = verifyTaskFileClaims(
        wp,
        { filesCreated: ['src/old.ts'] },
        ['src/old.ts'],
        taskStartedAt
      )
      // Verification fails (stale)
      assert.equal(result.ok, false)
      assert.equal(result.staleClaimed.length, 1)
      // But no files are actually missing
      assert.equal(result.missingClaimed.length, 0)
      assert.equal(result.missingPlanned.length, 0)

      // This is the soft-pass condition:
      const description =
        'Re-run the full verify pass with evidence: eslint, tsc, vitest, complexity, dead code'
      const isEvidenceOnly =
        !result.ok &&
        result.missingClaimed.length === 0 &&
        result.missingPlanned.length === 0 &&
        EVIDENCE_ONLY_RX.test(description)
      assert.equal(isEvidenceOnly, true, 'should qualify for evidence-only soft-pass')
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('evidence-only soft-pass — stale-only + code task → still hard-fails', () => {
  test('stale-only verification + normal code task description → does NOT qualify', () => {
    const wp = makeTmpWorkspace()
    try {
      mkdirSync(join(wp, 'src'), { recursive: true })
      writeFileSync(join(wp, 'src/old.ts'), 'stale content')
      const { utimesSync } = require('node:fs')
      const tenMinAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(join(wp, 'src/old.ts'), tenMinAgo, tenMinAgo)

      const taskStartedAt = Date.now()
      const result = verifyTaskFileClaims(
        wp,
        { filesCreated: ['src/old.ts'] },
        ['src/old.ts'],
        taskStartedAt
      )
      assert.equal(result.ok, false)
      assert.equal(result.staleClaimed.length, 1)

      // Normal code task—should NOT qualify
      const description = 'Implement user registration endpoint'
      const isEvidenceOnly =
        !result.ok &&
        result.missingClaimed.length === 0 &&
        result.missingPlanned.length === 0 &&
        EVIDENCE_ONLY_RX.test(description)
      assert.equal(isEvidenceOnly, false, 'normal code tasks must NOT qualify for soft-pass')
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

describe('evidence-only soft-pass — missing files + evidence description → still fails', () => {
  test('missing claimed files + evidence description → does NOT qualify for soft-pass', () => {
    const wp = makeTmpWorkspace()
    try {
      // src/a.ts does not exist
      const result = verifyTaskFileClaims(wp, { filesCreated: ['src/a.ts'] }, ['src/a.ts'])
      assert.equal(result.ok, false)
      assert.equal(result.missingClaimed.length, 1)

      // Even with an evidence description, missing files are NOT soft-passed
      const description = 'Re-run the full verify pass with evidence'
      const isEvidenceOnly =
        !result.ok &&
        (result.missingClaimed.length as number) === 0 &&
        (result.missingPlanned.length as number) === 0 &&
        EVIDENCE_ONLY_RX.test(description)
      assert.equal(isEvidenceOnly, false, 'missing claimed files must NOT qualify for soft-pass')
    } finally {
      cleanupTmpWorkspace(wp)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BP-CIRCULAR-VERIFY-FILTER: Remediation filter tests
// ═══════════════════════════════════════════════════════════════════════

describe('remediation filter — filters out circular re-run-verify tasks', () => {
  test('filters out "Re-run the full verify pass" task, keeps real tasks', () => {
    const tasks = [
      {
        taskId: 'R001',
        description: 'Fix missing error handling in auth.ts',
        files: ['src/auth.ts']
      },
      {
        taskId: 'R002',
        description:
          'Re-run the full verify pass with evidence: eslint, tsc, vitest, complexity, dead code',
        files: []
      },
      {
        taskId: 'R003',
        description: 'Add unit tests for user service',
        files: ['src/user.test.ts']
      }
    ]

    const filtered = tasks.filter((t) => !RERUN_VERIFY_RX.test(t.description))
    assert.equal(filtered.length, 2)
    assert.equal(filtered[0].taskId, 'R001')
    assert.equal(filtered[1].taskId, 'R003')
  })

  test('keeps all tasks when none match the circular pattern', () => {
    const tasks = [
      { taskId: 'R001', description: 'Fix TypeScript errors', files: ['src/index.ts'] },
      { taskId: 'R002', description: 'Add missing return type annotations', files: ['src/api.ts'] }
    ]

    const filtered = tasks.filter((t) => !RERUN_VERIFY_RX.test(t.description))
    assert.equal(filtered.length, 2)
  })

  test('filters out all tasks when all are circular verify tasks', () => {
    const tasks = [
      { taskId: 'R001', description: 're-run verify pass', files: [] },
      { taskId: 'R002', description: 'Re-run the verification with evidence', files: [] }
    ]

    const filtered = tasks.filter((t) => !RERUN_VERIFY_RX.test(t.description))
    assert.equal(filtered.length, 0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// GAP-C: Filter → fallback → filter ordering tests
// Tests the 3-step flow from GAP-1 + GAP-B rescue logic.
// ═══════════════════════════════════════════════════════════════════════

describe('filter → fallback → filter ordering (GAP-C)', () => {
  // Replicate the 3-step filter logic from blueprint-verify.service.ts
  // using the exported RERUN_VERIFY_RX as single source of truth.
  function simulateFilterFallbackFlow(
    agentTasks: Array<{ taskId: string; description: string; files: string[] }>,
    generatedTasks: Array<{ taskId: string; description: string; files: string[] }>
  ): {
    finalTasks: Array<{ taskId: string; description: string; files: string[] }>
    usedRescue: boolean
  } {
    const filterCircular = (tasks: typeof agentTasks) =>
      tasks.filter((t) => !RERUN_VERIFY_RX.test(t.description))

    // Step 1: Filter agent-provided tasks
    let result = filterCircular(agentTasks)

    let usedRescue = false
    // Step 2: If empty after filter, use generated fallback
    if (result.length === 0 && generatedTasks.length > 0) {
      // Step 3: Filter fallback-generated tasks too
      result = filterCircular(generatedTasks)

      // GAP-B rescue: if defensive filter emptied generated list, use generic task
      if (result.length === 0) {
        usedRescue = true
        result = [
          {
            taskId: 'R001',
            description: GENERIC_REMEDIATION_TASK_DESC,
            files: []
          }
        ]
      }
    }

    return { finalTasks: result, usedRescue }
  }

  test('all-circular agent tasks → fallback fires → non-circular fallback tasks survive', () => {
    const agentTasks = [
      { taskId: 'R001', description: 're-run verify pass', files: [] },
      { taskId: 'R002', description: 'Re-run the verification with evidence', files: [] }
    ]
    const generated = [
      {
        taskId: 'R001',
        description: 'Fix: missing error handling in auth.ts',
        files: ['src/auth.ts']
      }
    ]

    const { finalTasks, usedRescue } = simulateFilterFallbackFlow(agentTasks, generated)
    assert.equal(finalTasks.length, 1)
    assert.match(finalTasks[0].description, /Fix: missing error handling/)
    assert.equal(usedRescue, false)
  })

  test('agent tasks survive filter → fallback does NOT fire', () => {
    const agentTasks = [
      { taskId: 'R001', description: 'Fix TypeScript errors in user.ts', files: ['src/user.ts'] },
      { taskId: 'R002', description: 're-run verify pass', files: [] }
    ]
    const generated = [
      { taskId: 'R001', description: 'Fix: stub handler in api.ts', files: ['src/api.ts'] }
    ]

    const { finalTasks, usedRescue } = simulateFilterFallbackFlow(agentTasks, generated)
    // One agent task survived, so fallback never ran
    assert.equal(finalTasks.length, 1)
    assert.match(finalTasks[0].description, /Fix TypeScript errors/)
    assert.equal(usedRescue, false)
  })

  test('GAP-B rescue: all-circular agent tasks + all-circular generated tasks → generic rescue task', () => {
    const agentTasks = [{ taskId: 'R001', description: 're-run verify pass', files: [] }]
    // Edge case: generated task also matches the circular regex
    const generated = [
      { taskId: 'R001', description: 'Fix: verification evidence missing for eslint', files: [] }
    ]

    const { finalTasks, usedRescue } = simulateFilterFallbackFlow(agentTasks, generated)
    assert.equal(finalTasks.length, 1)
    assert.match(finalTasks[0].description, /Fix all gaps identified/)
    assert.equal(usedRescue, true)
  })

  test('generic rescue task does NOT match RERUN_VERIFY_RX', () => {
    const genericDesc = GENERIC_REMEDIATION_TASK_DESC
    assert.equal(RERUN_VERIFY_RX.test(genericDesc), false)
  })

  test('no agent tasks + no generated tasks → empty result, no rescue', () => {
    const { finalTasks, usedRescue } = simulateFilterFallbackFlow([], [])
    assert.equal(finalTasks.length, 0)
    assert.equal(usedRescue, false)
  })
})

// ── Standalone runner ──

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
) {
  void summaryAsync()
}

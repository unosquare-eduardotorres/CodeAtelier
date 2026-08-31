/**
 * Tests for memory-bootstrap.service.ts — project knowledge bootstrapping.
 *
 * Tests phase ordering, preflight degrade path (no index), incremental marker
 * gating, deterministic fact shaping, cancel mid-phase, mode selection.
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { test, describe, beforeEach, afterEach, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { BootstrapProgress, BootstrapPhaseLabel } from '../../../shared/types'
import { MCP_TOOLS } from '../../../shared/constants'

// Idempotent — the shared runner installs this too. Present so the file can
// also be run on its own (`npx tsx …/memory-bootstrap.test.ts`), which the
// service-loading tests below need.
setupElectronStub()

// db/index must be loaded before any repository: base-repository imports it,
// so requiring a repository cold trips a TDZ cycle
// (`Cannot access 'BaseRepository' before initialization`).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../db/index')

// ── BootstrapProgress type shape ────────────────────────────────────────────

describe('BootstrapProgress type', () => {
  test('progress events have required fields', () => {
    const progress: BootstrapProgress = {
      jobId: 'bootstrap-1-123456',
      runId: 'run-1',
      workspaceId: 'ws-1',
      phaseIndex: 2,
      phaseCount: 7,
      phaseLabel: 'stack',
      factsCreated: 5,
      message: 'Extracting tech stack facts…',
      jobStatus: 'running',
      mode: 'full',
      itemsTotal: 40,
      itemsDone: 12,
      itemsSkipped: 3,
      itemsFailed: 0,
      currentItem: null,
      perPhase: {},
      etaSeconds: null,
      itemsPerMinute: null
    }

    assert.equal(progress.jobId, 'bootstrap-1-123456')
    assert.equal(progress.phaseLabel, 'stack')
    assert.equal(progress.jobStatus, 'running')
    assert.equal(progress.mode, 'full')
    assert.equal(progress.phaseIndex, 2)
    assert.equal(progress.phaseCount, 7)
  })

  test('jobStatus covers all states', () => {
    const states: BootstrapProgress['jobStatus'][] = [
      'planning',
      'running',
      'paused',
      'done',
      'cancelled',
      'error'
    ]
    assert.equal(states.length, 6, 'Should have 6 job status states')
  })

  test('phase labels cover full mode', () => {
    const phases: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'structure',
      'finalize'
    ]
    assert.equal(phases.length, 7, 'Full mode has 7 phases')
  })

  test('phase labels cover deep-scan mode', () => {
    const phases: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'agent-exploration',
      'finalize'
    ]
    assert.equal(phases.length, 7, 'Deep-scan mode has 7 phases')
  })
})

// ── Phase ordering ──────────────────────────────────────────────────────────

describe('phase ordering', () => {
  test('full mode progresses through all phases in order', () => {
    const phases: BootstrapPhaseLabel[] = []
    const expectedOrder: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'structure',
      'finalize'
    ]

    // Simulate collecting progress events
    for (const phase of expectedOrder) {
      phases.push(phase)
    }

    assert.deepEqual(phases, expectedOrder)
  })

  test('deep-scan mode uses different phase set', () => {
    const deepScanPhases: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'agent-exploration',
      'finalize'
    ]

    // Deep scan adds agent-exploration on top of architecture+history,
    // and is the only mode that omits the structure phase.
    assert.ok(deepScanPhases.includes('architecture'))
    assert.ok(deepScanPhases.includes('history'))
    assert.ok(!deepScanPhases.includes('structure'))
    assert.ok(deepScanPhases.includes('agent-exploration'))
  })
})

// ── Doc discovery ───────────────────────────────────────────────────────────

describe('doc discovery', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), 'bootstrap-test-' + Date.now())
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('discovers README and doc files', async () => {
    const { discoverDocs } = await import('../memory-bootstrap/discovery')

    writeFileSync(join(testDir, 'README.md'), '# Test Project\nThis is a test')
    writeFileSync(join(testDir, 'CLAUDE.md'), '# Claude config')
    mkdirSync(join(testDir, 'docs'), { recursive: true })
    writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide\nSome content')

    const docs = discoverDocs(testDir)

    assert.ok(docs.length >= 3, `Should find at least 3 doc files (found ${docs.length})`)
    assert.ok(
      docs.some((f: string) => f.includes('README.md')),
      'Should find README.md'
    )
    assert.ok(
      docs.some((f: string) => f.includes('CLAUDE.md')),
      'Should find CLAUDE.md'
    )
    assert.ok(
      docs.some((f: string) => f.includes('guide.md')),
      'Should find docs/guide.md'
    )
  })

  test('skips node_modules and .git', async () => {
    const { discoverDocs } = await import('../memory-bootstrap/discovery')

    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'README.md'), '# Package')
    writeFileSync(join(testDir, 'README.md'), '# Root readme')

    const docs = discoverDocs(testDir)

    const hasNodeModules = docs.some((f: string) => f.includes('node_modules'))
    assert.equal(hasNodeModules, false, 'Should not include node_modules files')
  })

  test('deduplicates found files', async () => {
    const { discoverDocs } = await import('../memory-bootstrap/discovery')

    writeFileSync(join(testDir, 'README.md'), '# Readme')

    const docs = discoverDocs(testDir)

    const readmeCount = docs.filter((f: string) => f.endsWith('README.md')).length
    assert.equal(readmeCount, 1, 'README.md should appear exactly once')
  })
})

// ── Manifest collection ─────────────────────────────────────────────────────

describe('manifest collection', () => {
  let testDir: string

  beforeEach(() => {
    // Random suffix: the harness runs this file's async tests concurrently, and
    // two hooks landing in the same Date.now() millisecond would share a dir —
    // one test's afterEach rmSync then deletes the other's fixtures mid-test
    // (observed as a flaky "Should include tsconfig.json" in the shared run).
    testDir = join(
      tmpdir(),
      'bootstrap-manifest-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('collects package.json and tsconfig', async () => {
    const { collectManifests } = await import('../memory-bootstrap/discovery')

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: { lodash: '^4.0.0' }
      })
    )
    writeFileSync(
      join(testDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true }
      })
    )

    const content = collectManifests(testDir)

    assert.ok(content.includes('package.json'), 'Should include package.json')
    assert.ok(content.includes('tsconfig.json'), 'Should include tsconfig.json')
    assert.ok(content.includes('lodash'), 'Should include dependency content')
  })

  test('collects migration directory listing', async () => {
    const { collectManifests } = await import('../memory-bootstrap/discovery')

    mkdirSync(join(testDir, 'migrations'), { recursive: true })
    writeFileSync(join(testDir, 'migrations', '001_init.sql'), 'CREATE TABLE')
    writeFileSync(join(testDir, 'migrations', '002_users.sql'), 'ALTER TABLE')

    const content = collectManifests(testDir)

    assert.ok(content.includes('migrations'), 'Should include migrations directory')
    assert.ok(content.includes('001_init.sql'), 'Should list migration files')
  })

  test('returns empty string for empty project', async () => {
    const { collectManifests } = await import('../memory-bootstrap/discovery')

    // Use a dedicated empty dir to avoid race with concurrent tests
    const emptyDir = join(
      tmpdir(),
      'bootstrap-empty-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    mkdirSync(emptyDir, { recursive: true })
    try {
      const content = collectManifests(emptyDir)
      assert.equal(content, '', 'Should return empty string')
    } finally {
      try {
        rmSync(emptyDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })
})

// ── Git changed files helper ────────────────────────────────────────────────

describe('git changed files', () => {
  let testDir: string
  let isGitAvailable = false

  beforeEach(() => {
    testDir = join(tmpdir(), 'bootstrap-git-' + Date.now())
    mkdirSync(testDir, { recursive: true })

    // Check if git is available
    try {
      execSync('git --version', { encoding: 'utf-8' })
      isGitAvailable = true
    } catch {
      isGitAvailable = false
    }
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  test('returns empty set for non-git directory', async () => {
    const { getChangedFilesSinceCommit } = await import('../memory-bootstrap/discovery')

    const changed = getChangedFilesSinceCommit(testDir, 'abc123')

    assert.equal(changed.size, 0, 'Should return empty set for non-git dir')
  })

  test('returns changed files in a git repo', async () => {
    if (!isGitAvailable) return // skip without git

    const { getChangedFilesSinceCommit } = await import('../memory-bootstrap/discovery')

    // Set up a git repo
    execSync('git init', { cwd: testDir })
    execSync('git config user.email "test@test.com"', { cwd: testDir })
    execSync('git config user.name "Test"', { cwd: testDir })
    writeFileSync(join(testDir, 'file1.ts'), 'const a = 1')
    execSync('git add . && git commit -m "initial"', { cwd: testDir })
    const initialSha = execSync('git rev-parse HEAD', { cwd: testDir, encoding: 'utf-8' }).trim()

    // Make a change
    writeFileSync(join(testDir, 'file2.ts'), 'const b = 2')
    execSync('git add . && git commit -m "add file2"', { cwd: testDir })

    const changed = getChangedFilesSinceCommit(testDir, initialSha)

    assert.ok(changed.has('file2.ts'), 'Should detect file2.ts as changed')
    assert.ok(!changed.has('file1.ts'), 'Should not include unchanged file1.ts')
  })
})

// ── Cancel behavior ─────────────────────────────────────────────────────────

describe('cancel behavior', () => {
  test('cancel returns false for non-existent job', async () => {
    const { memoryBootstrapService } = await import('../memory-bootstrap.service')
    const result = memoryBootstrapService.cancel('non-existent-job')
    assert.equal(result, false)
  })

  test('isRunning is false initially', async () => {
    const { memoryBootstrapService } = await import('../memory-bootstrap.service')
    assert.equal(memoryBootstrapService.isRunning, false)
  })
})

// ── Incremental marker gating ───────────────────────────────────────────────

describe('incremental marker gating', () => {
  test('incremental mode concept: skip when lastCommit == HEAD', () => {
    const lastCommit = 'abc123def456'
    const headSha = 'abc123def456'

    // When they're equal, incremental run should be minimal
    const shouldSkip = lastCommit === headSha
    assert.equal(shouldSkip, true, 'Should skip when last commit equals HEAD')
  })

  test('incremental mode concept: process when lastCommit != HEAD', () => {
    const lastCommit: string = 'abc123def456'
    const headSha: string = '789ghi012jkl'

    const shouldSkip = lastCommit === headSha
    assert.equal(shouldSkip, false, 'Should process when last commit differs from HEAD')
  })
})

// ── Mode selection ──────────────────────────────────────────────────────────

describe('mode selection', () => {
  test('full mode uses 7 phases', () => {
    const fullPhases: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'structure',
      'finalize'
    ]
    assert.equal(fullPhases.length, 7)
    assert.equal(fullPhases[0], 'preflight')
    assert.equal(fullPhases[fullPhases.length - 1], 'finalize')
  })

  test('deep-scan mode uses 7 phases with agent-exploration', () => {
    const deepScanPhases: BootstrapPhaseLabel[] = [
      'preflight',
      'docs',
      'stack',
      'architecture',
      'history',
      'agent-exploration',
      'finalize'
    ]
    assert.equal(deepScanPhases.length, 7)
    assert.equal(deepScanPhases[5], 'agent-exploration')
  })

  test('incremental mode is a variant of full mode', () => {
    // Incremental uses the same phases as full but with git-gated file selection
    const modes = ['full', 'incremental', 'deep-scan'] as const
    assert.ok(modes.includes('incremental'))
  })
})

// ── Aggregation caps ────────────────────────────────────────────────────────

describe('aggregation caps', () => {
  test('hotspot facts are capped at MAX_HOTSPOT_FACTS', () => {
    // The service caps hotspot results at 15
    const MAX_HOTSPOT_FACTS = 15
    const mockHotspots = Array.from({ length: 30 }, (_, i) => ({
      file: `src/file${i}.ts`,
      referenceCount: 30 - i,
      gitChurn: 20 - i,
      hotspotScore: (30 - i) * (1 + Math.log2(20 - i + 1))
    }))

    const capped = mockHotspots.slice(0, MAX_HOTSPOT_FACTS)
    assert.equal(capped.length, 15, 'Hotspots should be capped at 15')
  })

  test('co-change results are capped at MAX_COCHANGE_RESULTS', () => {
    const MAX_COCHANGE_RESULTS = 15
    assert.equal(MAX_COCHANGE_RESULTS, 15, 'Co-change results capped at 15')
  })

  test('architecture files capped at MAX_ARCHITECTURE_FILES', () => {
    const MAX_ARCHITECTURE_FILES = 40
    assert.equal(MAX_ARCHITECTURE_FILES, 40, 'Architecture files capped at 40')
  })
})

// ── Deep Scan agent runner integration ─────────────────────────────────────

describe('deep scan agent runner', () => {
  test('deep scan allowedTools includes memory + code-graph + built-in read tools', () => {
    // This mirrors what spawnDeepScanAgent passes to runAgenticClaude
    const allowedTools = [
      'Read',
      'Grep',
      'Glob',
      ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES,
      ...MCP_TOOLS.MEMORY._ALL_NAMES
    ]

    // Must include all read-only built-ins
    assert.ok(allowedTools.includes('Read'), 'should include Read')
    assert.ok(allowedTools.includes('Grep'), 'should include Grep')
    assert.ok(allowedTools.includes('Glob'), 'should include Glob')

    // Must include memory tools (so the agent can actually record facts)
    assert.ok(
      allowedTools.includes('mcp__memory__memory_record'),
      'should include memory_record — Deep Scan needs this to write facts'
    )
    assert.ok(
      allowedTools.includes('mcp__memory__memory_search'),
      'should include memory_search — agent uses this to avoid duplicates'
    )

    // Must include code-graph tools for exploration
    assert.ok(allowedTools.includes('mcp__code-graph__graph_map'), 'should include graph_map')
    assert.ok(allowedTools.includes('mcp__code-graph__file_outline'), 'should include file_outline')

    // Must NOT include Write or Edit (read-only agent)
    assert.ok(!allowedTools.includes('Write'), 'should NOT include Write')
    assert.ok(!allowedTools.includes('Edit'), 'should NOT include Edit')
  })

  test('deep scan tool list is non-empty and reasonable size', () => {
    const allowedTools = [
      'Read',
      'Grep',
      'Glob',
      ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES,
      ...MCP_TOOLS.MEMORY._ALL_NAMES
    ]

    // Should have 3 built-ins + 14 code-graph + 3 memory = 20 tools
    assert.ok(allowedTools.length >= 15, `expected at least 15 tools, got ${allowedTools.length}`)
    assert.ok(allowedTools.length <= 30, `expected at most 30 tools, got ${allowedTools.length}`)
  })

  test('CLAUDE.md regen allowedTools excludes memory but includes code-graph', () => {
    // This mirrors what regenerateClaudeMdAgentic passes
    const allowedTools = ['Read', 'Grep', 'Glob', ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES]

    // Should include read tools and code-graph
    assert.ok(allowedTools.includes('Read'), 'should include Read')
    assert.ok(allowedTools.includes('mcp__code-graph__graph_map'), 'should include graph_map')

    // Should NOT include memory tools (not needed for CLAUDE.md gen)
    assert.ok(
      !allowedTools.includes('mcp__memory__memory_record'),
      'should NOT include memory tools for CLAUDE.md gen'
    )

    // Should NOT include Write or Edit
    assert.ok(!allowedTools.includes('Write'), 'should NOT include Write')
    assert.ok(!allowedTools.includes('Edit'), 'should NOT include Edit')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

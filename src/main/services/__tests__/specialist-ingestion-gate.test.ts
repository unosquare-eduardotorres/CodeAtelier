/**
 * Tests for the Project Specialist ingestion gate and build provenance.
 *
 * Background: a specialist whose LLM tailoring silently failed used to be
 * persisted with build_status='ready' and the untouched template skeleton —
 * visually identical to a genuinely tailored one. Two mechanisms address that:
 *
 *   1. A hard gate — no build at all until the workspace knowledge bootstrap
 *      has completed with facts (the tailoring step has nothing to work from
 *      before that).
 *   2. `specialists.build_method` provenance — 'agentic' | 'oneshot' |
 *      'skeleton' — so a degraded build is visible in the UI.
 *
 * DB-backed tests use the in-memory test DB helper and skip gracefully when
 * the better-sqlite3 native module is unavailable.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { trySetupTestDb, seedWorkspace } from '../../db/repositories/__tests__/db-test-helper'
import {
  isIngestionSatisfied,
  requireIngestionRun,
  augmentSkeleton,
  extractPromptBlock,
  specialistBuilderService
} from '../specialist-builder.service'
import { detectFromCodeGraph } from '../tech-stack-detector.service'
import { SpecialistIngestionRequiredError } from '../../../shared/errors'
import type { BootstrapRunSummary } from '../../../shared/types'
import type { TechStackResult } from '../tech-stack-detector.service'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function run(overrides: Partial<BootstrapRunSummary> = {}): BootstrapRunSummary {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    mode: 'full',
    scope: 'all',
    status: 'completed',
    currentPhase: null,
    itemsTotal: 10,
    itemsDone: 10,
    itemsSkipped: 0,
    itemsFailed: 0,
    factsCreated: 42,
    activeMs: 1000,
    error: null,
    createdAt: '2026-08-05T09:00:00Z',
    finishedAt: '2026-08-05T09:05:00Z',
    perPhase: {},
    ...overrides
  } as BootstrapRunSummary
}

function techs(detectedTechs: string[]): TechStackResult {
  return { detectedTechs, recommendedSkills: [], recommendedMcps: [], confidence: {} }
}

// ── Pure gate predicate ──────────────────────────────────────────────────────

describe('isIngestionSatisfied', () => {
  test('completed_run_with_facts_passes', () => {
    assert.equal(isIngestionSatisfied(run()), true)
  })

  test('no_run_fails', () => {
    assert.equal(isIngestionSatisfied(null), false)
    assert.equal(isIngestionSatisfied(undefined), false)
  })

  test('completed_run_with_zero_facts_fails', () => {
    // A completed run that extracted nothing leaves the builder just as blind
    // as no run at all — that is the whole point of the facts check.
    assert.equal(isIngestionSatisfied(run({ factsCreated: 0 })), false)
  })

  test('unfinished_run_fails', () => {
    for (const status of ['running', 'paused', 'planning', 'failed', 'cancelled']) {
      assert.equal(
        isIngestionSatisfied(run({ status: status as BootstrapRunSummary['status'] })),
        false,
        `status=${status} must not satisfy the gate`
      )
    }
  })
})

// ── Skeleton augmentation (B-c / B-d) ────────────────────────────────────────

describe('augmentSkeleton', () => {
  const skeleton = 'Intro line.\n\n## Decision heuristics\n- something\n'

  test('names_stack_when_no_claude_md', () => {
    const out = augmentSkeleton(skeleton, techs(['dotnet', 'csharp']), false)
    assert.ok(out.includes('## Stack'), 'should add a Stack section')
    assert.ok(out.includes('dotnet, csharp'), 'should name the detected techs')
    assert.ok(out.includes('## Decision heuristics'), 'must keep the original sections')
  })

  test('stays_silent_when_claude_md_exists', () => {
    // CLAUDE.md is injected at runtime and already covers the stack.
    assert.equal(augmentSkeleton(skeleton, techs(['dotnet']), true), skeleton)
  })

  test('stays_silent_when_no_techs_detected', () => {
    assert.equal(augmentSkeleton(skeleton, techs([]), false), skeleton)
  })
})

// ── Agentic output extraction ────────────────────────────────────────────────

describe('extractPromptBlock', () => {
  test('extracts_sentinel_block', () => {
    const stdout = [
      'Let me look at the code graph first.',
      '===SPECIALIST_PROMPT_BEGIN===',
      'You are the MULLIGAN Specialist.',
      '===SPECIALIST_PROMPT_END===',
      'Done.'
    ].join('\n')
    assert.equal(extractPromptBlock(stdout), 'You are the MULLIGAN Specialist.')
  })

  test('falls_back_to_whole_stdout_without_sentinels', () => {
    assert.equal(extractPromptBlock('  bare prompt text  '), 'bare prompt text')
  })

  test('returns_null_on_empty_output', () => {
    assert.equal(extractPromptBlock('   \n  '), null)
  })

  test('ignores_end_sentinel_before_begin', () => {
    const stdout = '===SPECIALIST_PROMPT_END===\nnoise\n===SPECIALIST_PROMPT_BEGIN==='
    // Malformed — must not produce a negative-length slice.
    assert.equal(extractPromptBlock(stdout), stdout.trim())
  })
})

// ── Meta-prompt: conditional CLAUDE.md deferral (B-c) ─────────────────────────

describe('buildMetaPrompt CLAUDE.md conditionality', () => {
  const base = {
    workspaceName: 'MULLIGAN',
    detectedTechs: ['dotnet', 'csharp'],
    claudeMdReference: '(no CLAUDE.md found in this repo)',
    skeleton: 'skeleton'
  }

  test('defers_to_claude_md_when_present', () => {
    const out = specialistBuilderService.buildMetaPrompt({ ...base, hasClaudeMd: true })
    assert.ok(out.includes('CLAUDE.md covers that'), 'should keep the deferral rules')
  })

  test('requires_naming_the_stack_when_claude_md_absent', () => {
    const out = specialistBuilderService.buildMetaPrompt({ ...base, hasClaudeMd: false })
    assert.ok(
      !out.includes('CLAUDE.md covers that'),
      'deferring to a non-existent CLAUDE.md would strip every project fact'
    )
    assert.ok(out.includes('DO name the stack'), 'should instruct it to state the stack')
  })

  test('defaults_to_deferral_for_legacy_callers', () => {
    const out = specialistBuilderService.buildMetaPrompt(base)
    assert.ok(out.includes('CLAUDE.md covers that'))
  })

  test('agentic_mode_adds_investigation_and_sentinels', () => {
    const out = specialistBuilderService.buildMetaPrompt({
      ...base,
      hasClaudeMd: true,
      agentic: true,
      ingestedFacts: '- [architecture] Layering: API → Domain → Data'
    })
    assert.ok(out.includes('BEFORE WRITING, INVESTIGATE'), 'agentic runs must be told to explore')
    assert.ok(out.includes('===SPECIALIST_PROMPT_BEGIN==='), 'must request the sentinel wrapper')
    assert.ok(out.includes('API → Domain → Data'), 'must inject the ingested facts')
  })

  test('non_agentic_mode_omits_sentinels', () => {
    const out = specialistBuilderService.buildMetaPrompt({ ...base, hasClaudeMd: true })
    assert.ok(!out.includes('===SPECIALIST_PROMPT_BEGIN==='))
  })
})

// ── DB-backed: gate + provenance persistence ─────────────────────────────────

const env = trySetupTestDb()

if (!env) {
  describe('specialist ingestion gate (skipped — native module unavailable)', () => {
    test('db_backed_gate', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db } = env

  // Async tests in this harness run concurrently, so every DB-mutating test
  // gets its own workspace rather than sharing (and racing on) one.
  const freshWorkspace = (name: string): string => seedWorkspace(db, `ws-${name}`)

  const seedSpecialist = (workspaceId: string): string => {
    const row = db
      .prepare(
        `INSERT INTO specialists (workspace_id, agent_id, display_name, prompt, build_status)
         VALUES (?, ?, ?, '', 'pending') RETURNING id`
      )
      .get(workspaceId, `workspace-specialist-${workspaceId}`, 'MULLIGAN Specialist') as {
      id: string
    }
    return row.id
  }

  const seedRun = (workspaceId: string, status: string, factsCreated: number): string => {
    const row = db
      .prepare(
        `INSERT INTO memory_bootstrap_runs (workspace_id, mode, scope, status, facts_created, finished_at)
         VALUES (?, 'full', 'all', ?, ?, datetime('now')) RETURNING id`
      )
      .get(workspaceId, status, factsCreated) as { id: string }
    return row.id
  }

  describe('migration 134', () => {
    test('adds_provenance_columns', () => {
      const cols = (
        db.prepare(`PRAGMA table_info(specialists)`).all() as Array<{ name: string }>
      ).map((c) => c.name)
      assert.ok(cols.includes('build_method'), 'build_method column must exist')
      assert.ok(cols.includes('ingestion_run_id'), 'ingestion_run_id column must exist')
    })
  })

  describe('requireIngestionRun', () => {
    test('throws_without_any_run', () => {
      const ws = freshWorkspace('req-none')
      assert.throws(
        () => requireIngestionRun(ws),
        (err: unknown) => err instanceof SpecialistIngestionRequiredError
      )
    })

    test('throws_when_latest_run_produced_no_facts', () => {
      const ws = freshWorkspace('req-zero')
      seedRun(ws, 'completed', 0)
      assert.throws(
        () => requireIngestionRun(ws),
        (err: unknown) => err instanceof SpecialistIngestionRequiredError
      )
    })

    test('returns_run_when_completed_with_facts', () => {
      const ws = freshWorkspace('req-ok')
      const runId = seedRun(ws, 'completed', 17)
      const resolved = requireIngestionRun(ws)
      assert.equal(resolved.id, runId)
      assert.equal(resolved.factsCreated, 17)
    })
  })

  describe('runBuild gating + provenance', () => {
    test('build_is_refused_before_ingestion', async () => {
      const ws = freshWorkspace('build-gated')
      seedSpecialist(ws)

      await assert.rejects(
        () => specialistBuilderService.buildProjectSpecialist(ws, { useLLM: false }),
        (err: unknown) => err instanceof SpecialistIngestionRequiredError
      )

      // The gate runs before build_status is flipped, so a refused build must
      // not leave the specialist stranded in 'building' or 'failed'.
      const row = db
        .prepare(`SELECT build_status FROM specialists WHERE workspace_id = ?`)
        .get(ws) as { build_status: string }
      assert.equal(row.build_status, 'pending')
    })

    test('fallback_path_persists_skeleton_provenance', async () => {
      const ws = freshWorkspace('build-skeleton')
      const specialistId = seedSpecialist(ws)
      const runId = seedRun(ws, 'completed', 9)

      const result = await specialistBuilderService.buildProjectSpecialist(ws, {
        useLLM: false
      })

      assert.equal(result.buildMethod, 'skeleton')
      assert.equal(result.usedLLM, false)
      assert.equal(result.ingestionRunId, runId)

      const row = db
        .prepare(
          `SELECT build_method, ingestion_run_id, build_status FROM specialists WHERE id = ?`
        )
        .get(specialistId) as {
        build_method: string | null
        ingestion_run_id: string | null
        build_status: string
      }
      assert.equal(row.build_method, 'skeleton', 'a skeleton build must say so on disk')
      assert.equal(row.ingestion_run_id, runId)
      assert.equal(row.build_status, 'ready')
    })

    test('skills_only_rebuild_bypasses_the_gate', async () => {
      const ws = freshWorkspace('build-skills-only')
      const specialistId = seedSpecialist(ws)

      // No bootstrap run at all — re-detecting the stack must still work,
      // since it involves no LLM tailoring.
      const result = await specialistBuilderService.rebuildSkills(specialistId)
      assert.equal(result.specialistId, specialistId)
      assert.equal(result.ingestionRunId, null)

      const row = db
        .prepare(`SELECT build_method FROM specialists WHERE id = ?`)
        .get(specialistId) as { build_method: string | null }
      assert.equal(row.build_method, null, 'skills-only must not claim prompt provenance')
    })
  })

  describe('detectFromCodeGraph', () => {
    const insertTags = (workspaceId: string, relFname: string, count = 1): void => {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO code_graph_tags
           (workspace_id, rel_fname, fname, line, name, kind, file_mtime)
         VALUES (?, ?, ?, ?, ?, 'def', 0)`
      )
      for (let i = 0; i < count; i++) stmt.run(workspaceId, relFname, relFname, i, `sym${i}`)
    }

    test('infers_dotnet_and_csharp_from_cs_files', () => {
      const ws = freshWorkspace('cg-cs')
      // 6 distinct .cs files, several tags each — the threshold counts FILES,
      // which is why the query has to be DISTINCT rel_fname.
      for (let i = 0; i < 6; i++) insertTags(ws, `src/Domain/Entity${i}.cs`, 3)

      const found = detectFromCodeGraph(ws)
      assert.ok(found.has('dotnet'), 'expected dotnet')
      assert.ok(found.has('csharp'), 'expected csharp')
    })

    test('ignores_extensions_below_the_file_threshold', () => {
      const ws = freshWorkspace('cg-stray')
      // One stray .py file with many tags must not register python.
      insertTags(ws, 'scripts/one_off.py', 50)

      const found = detectFromCodeGraph(ws)
      assert.equal(found.has('python'), false, 'a single file is not evidence of a stack')
    })

    test('returns_empty_for_unindexed_workspace', () => {
      assert.equal(detectFromCodeGraph(freshWorkspace('cg-empty')).size, 0)
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

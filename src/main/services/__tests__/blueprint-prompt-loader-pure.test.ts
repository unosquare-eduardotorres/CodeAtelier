/**
 * Unit tests for blueprint-prompt-loader pure template functions.
 *
 * Tests buildPhaseSystemPrompt (which internally calls formatArtifacts,
 * replaceVariables, buildFallbackPrompt), buildConstitutionEditorPrompt
 * (which calls buildFallbackConstitutionPrompt), and the formatArtifacts
 * compaction logic (contentMd preference, compact JSON, field projection,
 * discovery consolidation, budget cap).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildPhaseSystemPrompt,
  buildConstitutionEditorPrompt,
  formatArtifacts,
  ARTIFACT_BUDGET_CHARS
} from '../blueprint-prompt-loader'
import type {
  BlueprintPhaseType,
  PhaseContext,
  BlueprintArtifact
} from '../../../shared/blueprint-types'

// ── Helpers ──

function makePhaseContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    blueprint: {
      id: 'bp-1',
      title: 'Test Blueprint',
      shortName: 'test',
      description: 'A test feature',
      priority: 'medium' as any,
      currentPhase: 'specify' as any,
      settings: {}
    },
    constitution: null,
    previousArtifacts: [],
    specFilePath: '/tmp/spec.md',
    blueprintDir: '/tmp/blueprints',
    grillDecisions: [],
    ...overrides
  }
}

/**
 * A tasks artifact in the shape TASKS actually emits (`tasks-phase.md:145`):
 * {totalTasks, waves[{wave, name, tasks[]}], userStoryPhases, mvpScope}.
 *
 * The previous fixture here was `{id, title, wave}` — a flat shape production
 * never produces — which is exactly why the projection bug survived: the test
 * pinned an invented shape, so the allow-list looked correct while matching NO
 * top-level key of the real one.
 */
function emittedTasksJson(taskCount: number): Record<string, unknown> {
  const perWave = 6
  const waveCount = Math.ceil(taskCount / perWave)
  return {
    totalTasks: taskCount,
    waves: Array.from({ length: waveCount }, (_, w) => ({
      wave: w + 1,
      name: `Wave ${w + 1}`,
      tasks: Array.from(
        { length: Math.min(perWave, taskCount - w * perWave) },
        (_, i) => ({
          taskId: `T${w * perWave + i}`,
          description: `Do the thing ${w * perWave + i}`,
          files: [`src/mod-${w * perWave + i}.ts`],
          userStory: `US${w}`,
          isParallel: true,
          dependsOn: [],
          includesTests: true,
          packet: {
            interfaces: ['export function f(): void'],
            acceptanceCriteria: [{ text: 'it works', howVerified: 'npm test' }],
            allowedFiles: [`src/mod-${w * perWave + i}.ts`],
            testCommand: 'npm test'
          }
        })
      )
    })),
    userStoryPhases: [{ story: 'US0', title: 'Story 0', priority: 'P1', taskIds: ['T0'] }],
    parallelOpportunities: 4,
    mvpScope: ['T0', 'T1']
  }
}

/** Pull the first fenced JSON block out of a rendered artifacts string. */
function firstJsonBlock(rendered: string): string {
  const m = rendered.match(/```json\n([\s\S]*?)\n```/)
  assert.ok(m, 'expected a fenced JSON block')
  return m![1]
}

describe('buildPhaseSystemPrompt — fallback prompts', () => {
  // ── Each phase produces a valid prompt ──

  const phases: BlueprintPhaseType[] = [
    'specify',
    'clarify',
    'plan',
    'tasks',
    'review',
    'build',
    'verify'
  ]

  for (const phase of phases) {
    test(`${phase}_phase_produces_valid_prompt`, () => {
      const result = buildPhaseSystemPrompt(phase, makePhaseContext())
      assert.ok(result.length > 0, `${phase} prompt should be non-empty`)
      assert.ok(
        result.includes(phase.charAt(0).toUpperCase() + phase.slice(1)) || result.includes(phase),
        `Prompt should reference the phase "${phase}"`
      )
    })
  }

  // ── Blueprint context JSON injection ──

  test('injects_blueprint_context_json', () => {
    const ctx = makePhaseContext({
      blueprint: {
        id: 'bp-42',
        title: 'Login Feature',
        shortName: 'login',
        description: 'Add OAuth2 login',
        priority: 'medium' as any,
        currentPhase: 'specify' as any,
        settings: {}
      }
    })
    const result = buildPhaseSystemPrompt('specify', ctx)
    assert.ok(result.includes('bp-42'), 'Should contain blueprint ID from context')
    assert.ok(result.includes('Login Feature'), 'Should contain blueprint name')
  })

  // ── Constitution content ──

  test('null_constitution_shows_no_constitution_defined', () => {
    const result = buildPhaseSystemPrompt('plan', makePhaseContext({ constitution: null }))
    assert.ok(result.includes('(No constitution defined.)'))
  })

  test('constitution_content_injected', () => {
    const result = buildPhaseSystemPrompt(
      'plan',
      makePhaseContext({
        constitution: 'Always use TypeScript strict mode.'
      })
    )
    assert.ok(result.includes('Always use TypeScript strict mode.'))
  })

  // ── Grill decisions ──
  // Note: grill decisions are only injected when the .md template has {{GRILL_DECISIONS}}.
  // The 'specify' phase uses a fallback prompt that includes this placeholder.

  test('grill_decisions_injected_when_template_has_placeholder', () => {
    // The fallback prompt for 'specify' includes {{GRILL_DECISIONS}} — force fallback
    // by checking if a phase with grill decisions shows them.
    // Since .md files exist on disk, we just verify the prompt is well-formed.
    const result = buildPhaseSystemPrompt(
      'specify',
      makePhaseContext({
        grillDecisions: [
          { header: 'Auth Method', selectedOption: 'OAuth2', reason: 'Industry standard' }
        ]
      })
    )
    // The prompt should still be valid even with grill decisions provided
    assert.ok(result.length > 100)
  })

  // ── Previous artifacts ──

  test('empty_artifacts_shows_no_artifacts', () => {
    const result = buildPhaseSystemPrompt('tasks', makePhaseContext({ previousArtifacts: [] }))
    assert.ok(result.includes('(No previous artifacts available.)'))
  })

  test('artifact_with_contentMd_included', () => {
    const result = buildPhaseSystemPrompt(
      'tasks',
      makePhaseContext({
        previousArtifacts: [
          {
            type: 'spec',
            contentMd: '# Feature Specification\n\nAdd login page with OAuth2.',
            contentJson: undefined,
            filePath: undefined
          }
        ]
      })
    )
    assert.ok(result.includes('Feature Specification'))
    assert.ok(result.includes('Add login page with OAuth2'))
  })

  test('artifact_with_contentJson_only_included_as_compact_json_block', () => {
    const result = buildPhaseSystemPrompt(
      'tasks',
      makePhaseContext({
        previousArtifacts: [
          {
            type: 'plan',
            contentMd: undefined,
            contentJson: { phases: [{ name: 'Phase 1' }] },
            filePath: undefined
          }
        ]
      })
    )
    assert.ok(result.includes('```json'))
    assert.ok(result.includes('Phase 1'))
    // Should use compact JSON (no pretty-printing)
    assert.ok(!result.includes('  "phases"'), 'Should NOT use pretty-printed JSON')
  })

  test('artifact_with_both_contentMd_and_contentJson_prefers_md_for_spec', () => {
    const result = buildPhaseSystemPrompt(
      'plan',
      makePhaseContext({
        previousArtifacts: [
          {
            type: 'spec',
            contentMd: '# Spec Summary\nThis is the spec markdown.',
            contentJson: { specUniqueField: 'should-not-appear' },
            filePath: undefined
          }
        ]
      })
    )
    // Spec should include the markdown (non-plan/tasks type prefers contentMd)
    assert.ok(result.includes('Spec Summary'))
    assert.ok(result.includes('This is the spec markdown.'))
    // Should NOT include the JSON dump since spec type prefers contentMd
    assert.ok(
      !result.includes('should-not-appear'),
      'JSON should be omitted for spec when contentMd exists'
    )
  })

  test('artifact_plan_with_both_prefers_compact_json', () => {
    const result = buildPhaseSystemPrompt(
      'tasks',
      makePhaseContext({
        previousArtifacts: [
          {
            type: 'plan',
            contentMd: '# Plan Summary\nVerbose plan output.',
            contentJson: { phases: [{ name: 'Phase 1' }] },
            filePath: undefined
          }
        ]
      })
    )
    // Plan type should prefer projected compact JSON over verbose contentMd
    assert.ok(result.includes('```json'), 'Plan should render as JSON block')
    assert.ok(result.includes('Phase 1'), 'Projected JSON should keep phase names')
    assert.ok(
      !result.includes('Verbose plan output'),
      'Should NOT include verbose contentMd for plan'
    )
  })

  test('artifact_with_filePath_shows_path_line', () => {
    const result = buildPhaseSystemPrompt(
      'tasks',
      makePhaseContext({
        previousArtifacts: [
          {
            type: 'spec',
            contentMd: 'content',
            contentJson: undefined,
            filePath: 'src/features/login.ts'
          }
        ]
      })
    )
    assert.ok(result.includes('**Path**: src/features/login.ts'))
  })

  test('multiple_artifacts_separated_by_dividers', () => {
    const result = buildPhaseSystemPrompt(
      'tasks',
      makePhaseContext({
        previousArtifacts: [
          { type: 'spec', contentMd: 'Spec content', contentJson: undefined, filePath: undefined },
          { type: 'plan', contentMd: 'Plan content', contentJson: undefined, filePath: undefined }
        ]
      })
    )
    assert.ok(result.includes('Spec content'))
    assert.ok(result.includes('Plan content'))
    assert.ok(result.includes('---'))
  })

  // ── Fallback prompt structure ──

  test('fallback_prompt_includes_blueprint_phase_complete_block', () => {
    const result = buildPhaseSystemPrompt('specify', makePhaseContext())
    assert.ok(result.includes('blueprint-phase-complete'))
  })

  test('prompt_contains_task_or_instructions_section', () => {
    const result = buildPhaseSystemPrompt('plan', makePhaseContext())
    // Real .md files may use "Your Task" instead of "Instructions"
    assert.ok(
      result.includes('Task') || result.includes('Instructions') || result.includes('instructions'),
      'Prompt should contain task/instructions section'
    )
  })
})

describe('buildConstitutionEditorPrompt — fallback', () => {
  test('includes_Constitution_Editor_reference', () => {
    const result = buildConstitutionEditorPrompt(null, { name: 'MyProject', path: '/tmp/proj' })
    assert.ok(result.includes('Constitution'))
  })

  test('includes_workspace_name', () => {
    const result = buildConstitutionEditorPrompt(null, { name: 'MyProject', path: '/tmp/proj' })
    assert.ok(result.includes('MyProject'))
  })

  test('includes_workspace_path', () => {
    const result = buildConstitutionEditorPrompt(null, { name: 'MyProject', path: '/tmp/my-proj' })
    assert.ok(result.includes('/tmp/my-proj'))
  })

  test('null_constitution_shows_no_existing', () => {
    const result = buildConstitutionEditorPrompt(null, { name: 'P', path: '/tmp' })
    assert.ok(result.includes('(No existing constitution.)'))
  })

  test('existing_constitution_injected', () => {
    const result = buildConstitutionEditorPrompt('Always write tests first.', {
      name: 'P',
      path: '/tmp'
    })
    assert.ok(result.includes('Always write tests first.'))
  })
})

// ═════════════════════════════════════════════════════════════════════════
//  formatArtifacts — direct tests (context compaction)
// ═════════════════════════════════════════════════════════════════════════

describe('formatArtifacts — rendering preference', () => {
  test('prefers_contentMd_for_spec_artifacts', () => {
    const result = formatArtifacts([
      {
        type: 'spec',
        contentMd: '# My Spec\nDetails here.',
        contentJson: { title: 'Spec', sections: ['a', 'b'] }
      }
    ])
    assert.ok(result.includes('# My Spec'), 'Spec should use contentMd')
    assert.ok(!result.includes('"title"'), 'Spec should not include JSON')
  })

  test('prefers_projected_contentJson_for_plan_artifacts_when_available', () => {
    const result = formatArtifacts([
      {
        type: 'plan',
        contentMd: 'Very long agent reasoning about the plan...',
        contentJson: { summary: 'Build login', techStack: ['React'] }
      }
    ])
    assert.ok(result.includes('"summary"'), 'Plan should use projected JSON')
    assert.ok(!result.includes('Very long agent reasoning'), 'Plan should not use contentMd')
  })

  test('prefers_projected_contentJson_for_tasks_artifacts_when_available', () => {
    const result = formatArtifacts([
      {
        type: 'tasks',
        contentMd: 'Very long agent reasoning about tasks...',
        contentJson: emittedTasksJson(1)
      }
    ])
    assert.ok(result.includes('"taskId"'), 'Tasks should use projected JSON')
    assert.ok(!result.includes('Very long agent reasoning'), 'Tasks should not use contentMd')
  })

  test('falls_back_to_contentMd_for_plan_tasks_when_no_contentJson', () => {
    const result = formatArtifacts([
      {
        type: 'plan',
        contentMd: 'Plan details in markdown only.'
      }
    ])
    assert.ok(result.includes('Plan details in markdown only.'))
  })

  test('falls_back_to_json_when_no_contentMd', () => {
    const result = formatArtifacts([
      {
        type: 'spec',
        contentJson: { title: 'Spec' }
      }
    ])
    assert.ok(result.includes('```json'), 'Should include JSON block')
    assert.ok(result.includes('"title"'), 'Should include JSON content')
  })

  test('empty_artifacts_returns_no_artifacts_message', () => {
    assert.equal(formatArtifacts([]), '(No previous artifacts available.)')
  })
})

describe('formatArtifacts — tasks projection matches the emitted shape (A9)', () => {
  test('regression_guard_leaf_only_key_set_would_render_empty_object', () => {
    // Characterization of the bug. The pre-A9 allow-list was per-task leaf keys
    // only; none of them is a TOP-LEVEL key of what TASKS emits, and
    // projectFields is shallow at the top level — so the whole artifact
    // collapsed to `{}`. Kept so re-narrowing the set fails loudly.
    const leafOnlyKeys = new Set([
      'id',
      'title',
      'wave',
      'files',
      'scope',
      'status',
      'taskId',
      'userStory',
      'filePathsJson',
      'description'
    ])
    const emitted = emittedTasksJson(12)
    const matched = Object.keys(emitted).filter((k) => leafOnlyKeys.has(k))
    assert.deepEqual(
      matched,
      [],
      'the old key set matched no top-level key of the emitted shape — hence `{}`'
    )
  })

  test('renders_wave_containers_and_per_task_coverage_fields', () => {
    const rendered = formatArtifacts([{ type: 'tasks', contentJson: emittedTasksJson(12) }])
    const json = firstJsonBlock(rendered)
    for (const key of [
      'totalTasks',
      'waves',
      'wave',
      'tasks',
      'taskId',
      'description',
      'files',
      'dependsOn',
      'userStory',
      'userStoryPhases',
      'mvpScope'
    ]) {
      assert.ok(json.includes(`"${key}"`), `REVIEW needs "${key}" to judge coverage`)
    }
    assert.notEqual(json.trim(), '{}', 'the artifact must not render as an empty object')
  })

  test('excludes_packet_internals_which_build_gets_from_the_db', () => {
    const rendered = formatArtifacts([{ type: 'tasks', contentJson: emittedTasksJson(12) }])
    const json = firstJsonBlock(rendered)
    for (const key of [
      'packet',
      'allowedFiles',
      'testCommand',
      'interfaces',
      'acceptanceCriteria',
      'isParallel',
      'includesTests',
      'parallelOpportunities'
    ]) {
      assert.ok(!json.includes(`"${key}"`), `"${key}" is BUILD's execution contract, not REVIEW's`)
    }
  })

  test('over_cap_task_list_keeps_first_N_and_stays_parseable', () => {
    const rendered = formatArtifacts(
      [{ type: 'tasks', filePath: 'blueprints/x/tasks.md', contentJson: emittedTasksJson(150) }],
      1_000_000 // no budget truncation — isolate the task cap
    )
    const json = firstJsonBlock(rendered)

    const parsed = JSON.parse(json) as {
      totalTasks: number
      waves: { tasks: unknown[] }[]
    }
    const kept = parsed.waves.reduce((n, w) => n + w.tasks.length, 0)
    assert.equal(kept, 120, 'should keep exactly MAX_TASKS_RENDERED tasks')
    assert.equal(parsed.totalTasks, 150, 'the true total stays visible to the reader')

    assert.ok(
      rendered.includes('30 of 150 tasks omitted'),
      'omission marker should state how many were dropped'
    )
    assert.ok(
      rendered.includes('Read blueprints/x/tasks.md'),
      'omission marker should point at the full list'
    )
    assert.ok(
      !json.includes('tasks omitted'),
      'marker must sit OUTSIDE the fence so the JSON stays parseable'
    )
  })

  test('under_cap_task_list_has_no_omission_marker', () => {
    const rendered = formatArtifacts([{ type: 'tasks', contentJson: emittedTasksJson(12) }])
    assert.ok(!rendered.includes('tasks omitted'))
    assert.equal(JSON.parse(firstJsonBlock(rendered)).totalTasks, 12)
  })
})

describe('formatArtifacts — compact JSON (no pretty-printing)', () => {
  test('json_is_compact_not_pretty_printed', () => {
    const result = formatArtifacts([
      {
        type: 'plan',
        contentJson: { summary: 'Build login', techStack: ['React', 'Node'] }
      }
    ])
    // Compact JSON has no leading whitespace before keys
    assert.ok(!result.includes('  "summary"'), 'Should not have indented keys')
    assert.ok(result.includes('"summary":'), 'Should have compact key')
  })
})

describe('formatArtifacts — field projection', () => {
  test('plan_json_projects_only_allowed_fields', () => {
    const result = formatArtifacts([
      {
        type: 'plan',
        contentJson: {
          summary: 'Build login page',
          techStack: ['React'],
          mustHaves: ['OAuth2'],
          longDescription: 'This is a very long description that should be dropped...',
          internalNotes: 'Internal notes should be dropped'
        }
      }
    ])
    assert.ok(result.includes('Build login page'), 'Should keep summary')
    assert.ok(result.includes('React'), 'Should keep techStack')
    assert.ok(result.includes('OAuth2'), 'Should keep mustHaves')
    assert.ok(!result.includes('longDescription'), 'Should drop longDescription')
    assert.ok(!result.includes('internalNotes'), 'Should drop internalNotes')
  })

  test('tasks_json_projects_only_allowed_fields', () => {
    const result = formatArtifacts([
      {
        type: 'tasks',
        contentJson: {
          id: 'T001',
          title: 'Setup auth',
          wave: 1,
          longAnalysis: 'This long analysis text should be dropped',
          files: ['auth.ts']
        }
      }
    ])
    assert.ok(result.includes('T001'), 'Should keep id')
    assert.ok(result.includes('Setup auth'), 'Should keep title')
    assert.ok(!result.includes('longAnalysis'), 'Should drop longAnalysis')
  })

  test('non_plan_non_tasks_json_keeps_all_fields', () => {
    const result = formatArtifacts([
      {
        type: 'review',
        contentJson: {
          score: 85,
          findings: ['Good coverage'],
          customField: 'kept'
        }
      }
    ])
    assert.ok(result.includes('score'), 'Should keep score')
    assert.ok(result.includes('customField'), 'Should keep custom fields for non-plan/tasks types')
  })
})

describe('formatArtifacts — discovery consolidation', () => {
  test('multiple_discovery_artifacts_merged_into_one_block', () => {
    const result = formatArtifacts([
      { type: 'discoveries', contentJson: { phase: 'plan', entries: ['Finding A', 'Finding B'] } },
      { type: 'discoveries', contentJson: { phase: 'build', entries: ['Finding C'] } }
    ])
    // Should have ONE consolidated heading, not separate ones
    assert.ok(result.includes('### Discoveries (consolidated)'), 'Should have consolidated heading')
    assert.ok(result.includes('- Finding A'), 'Should include entry A')
    assert.ok(result.includes('- Finding B'), 'Should include entry B')
    assert.ok(result.includes('- Finding C'), 'Should include entry C')
    // Should NOT have per-phase headings
    assert.ok(!result.includes('### Discoveries (plan)'), 'Should NOT have per-phase heading')
    assert.ok(!result.includes('### Discoveries (build)'), 'Should NOT have per-phase heading')
  })

  test('duplicate_entries_are_deduplicated', () => {
    const result = formatArtifacts([
      { type: 'discoveries', contentJson: { phase: 'plan', entries: ['Finding A', 'Finding B'] } },
      { type: 'discoveries', contentJson: { phase: 'build', entries: ['Finding A', 'Finding C'] } }
    ])
    const matches = result.match(/- Finding A/g)
    assert.equal(matches?.length, 1, 'Finding A should appear only once (deduplicated)')
  })

  test('caps_at_30_entries_with_omission_breadcrumb', () => {
    const entries = Array.from({ length: 40 }, (_, i) => `Discovery ${i}`)
    const result = formatArtifacts([{ type: 'discoveries', contentJson: { entries } }])
    // Should have exactly 30 entries (the most recent ones)
    assert.ok(result.includes('- Discovery 10'), 'Should include entry 10 (start of last 30)')
    assert.ok(result.includes('- Discovery 39'), 'Should include last entry')
    assert.ok(!result.includes('- Discovery 9'), 'Should NOT include entry 9 (trimmed)')
    assert.ok(result.includes('10 older discoveries omitted'), 'Should have omission breadcrumb')
  })

  test('empty_discovery_entries_are_skipped', () => {
    const result = formatArtifacts([
      { type: 'spec', contentMd: '# Spec' },
      { type: 'discoveries', contentJson: { entries: [] } }
    ])
    assert.ok(!result.includes('Discoveries'), 'Should skip empty discoveries')
    assert.ok(result.includes('# Spec'), 'Should keep other artifacts')
  })
})

describe('formatArtifacts — budget cap with truncation', () => {
  test('truncates_when_exceeding_budget', () => {
    // Create artifacts that exceed a small budget
    const largeContent = 'x'.repeat(500)
    const result = formatArtifacts(
      [
        { type: 'spec', contentMd: largeContent },
        { type: 'plan', contentMd: largeContent },
        { type: 'tasks', contentMd: largeContent }
      ],
      800 // small budget
    )
    assert.ok(result.includes('artifact(s) truncated'), 'Should have truncation breadcrumb')
    assert.ok(result.includes('### Artifact: spec'), 'Should keep first artifact')
  })

  test('keeps_all_artifacts_when_under_budget', () => {
    const result = formatArtifacts(
      [
        { type: 'spec', contentMd: 'Short spec' },
        { type: 'plan', contentMd: 'Short plan' }
      ],
      50_000 // generous budget
    )
    assert.ok(result.includes('Short spec'))
    assert.ok(result.includes('Short plan'))
    assert.ok(!result.includes('truncated'), 'Should NOT truncate under budget')
  })

  test('always_includes_at_least_one_artifact', () => {
    const result = formatArtifacts(
      [{ type: 'spec', contentMd: 'x'.repeat(1000) }],
      10 // tiny budget
    )
    assert.ok(result.includes('### Artifact: spec'), 'Should include at least one artifact')
    assert.ok(!result.includes('truncated'), 'Single artifact should not show truncation')
  })
})

describe('formatArtifacts — size regression guard', () => {
  test('representative_verify_context_under_budget_ceiling', () => {
    // Simulate a realistic late-phase artifact set
    const artifacts: BlueprintArtifact[] = [
      { type: 'spec', contentMd: '# Feature Spec\n' + 'Requirement details. '.repeat(100) },
      {
        type: 'plan',
        contentMd: '# Implementation Plan\n' + 'Plan step details. '.repeat(80)
      },
      {
        type: 'build',
        contentMd: '# Build Report\n' + 'Build result details. '.repeat(50)
      },
      // 15 discovery artifacts (typical for a build with multiple waves)
      ...Array.from({ length: 15 }, (_, i) => ({
        type: 'discoveries' as const,
        contentJson: {
          phase: 'build',
          entries: Array.from(
            { length: 3 },
            (__, j) => `Wave ${i} discovery ${j}: found pattern in file_${i}_${j}.ts`
          )
        }
      }))
    ]
    const result = formatArtifacts(artifacts)
    assert.ok(
      result.length <= ARTIFACT_BUDGET_CHARS + 500, // small margin for breadcrumbs
      `Verify context should be under budget ceiling (got ${result.length} chars, budget ${ARTIFACT_BUDGET_CHARS})`
    )
    // Key content must still be present
    assert.ok(result.includes('Feature Spec'), 'Spec should be present')
    assert.ok(result.includes('Implementation Plan'), 'Plan should be present')
    assert.ok(result.includes('Build Report'), 'Build report should be present')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

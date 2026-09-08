/**
 * Unit tests for src/main/services/design-prompt-templates.ts
 *
 * The fixtures under `fixtures/impeccable-skill/` reproduce the REAL heading
 * structure of the provisioned payload (SKILL.md, reference/audit.md,
 * reference/critique.md) with shortened bodies, so the section-stripping rules
 * are exercised against the shapes they were designed for rather than against
 * invented markdown.
 *
 * The load-bearing invariant is the budget cap: `critique.md` is 42.7 KB in
 * reality, so an assembled layer that is not capped would silently blow the
 * prompt budget on the single most-used design command.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from './test-harness'
import {
  MAX_IMPECCABLE_LAYER_CHARS,
  assembleImpeccableLayer,
  getDesignScoringFocus,
  renderDesignPrompt,
  stripSections,
  summarizeDetectorFindings,
  truncateToSections,
  type DesignPromptParams
} from '../design-prompt-templates'

const FIXTURES = join(__dirname, 'fixtures', 'impeccable-skill')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

const SKILL = fixture('SKILL.md')
const AUDIT = fixture('audit.md')
const CRITIQUE = fixture('critique.md')

// ── stripSections ────────────────────────────────────────────────────────────

describe('stripSections', () => {
  test('drops the Setup section that would run the Impeccable launcher', () => {
    const out = stripSections(SKILL)
    assert.ok(!out.includes('## Setup'))
    assert.ok(!out.includes('scripts/impeccable context'))
  })

  test('keeps the design philosophy sections worth injecting', () => {
    const out = stripSections(SKILL)
    assert.ok(out.includes('## How to design'))
    assert.ok(out.includes('## Modes'))
  })

  test('drops the Commands table', () => {
    assert.ok(!stripSections(SKILL).includes('## Commands'))
  })

  test('dropping a ## section also drops its ### children', () => {
    const out = stripSections(AUDIT)
    assert.ok(!out.includes('## Generate Report'), 'parent must go')
    assert.ok(!out.includes('### Audit Health Score'), 'child must go with it')
    assert.ok(!out.includes('### Detailed Findings by Severity'))
  })

  test('keeps the audit diagnostic dimensions', () => {
    const out = stripSections(AUDIT)
    assert.ok(out.includes('## Diagnostic Scan'))
    for (const dim of ['Accessibility', 'Performance', 'Theming', 'Responsive', 'Integrity']) {
      assert.ok(out.includes(dim), `missing dimension: ${dim}`)
    }
  })

  test('drops critique orchestration but keeps Assessment A and the reference material', () => {
    const out = stripSections(CRITIQUE)
    assert.ok(!out.includes('### Assessment Orchestration'))
    assert.ok(!out.includes('### Deliver the Report'))
    assert.ok(!out.includes('### Persist the Snapshot'))
    assert.ok(!out.includes('### Ask the User'))
    assert.ok(!out.includes('### Generate Combined Critique Report'))
    assert.ok(!out.includes('#### Report header provenance'), 'nested child must go too')

    assert.ok(out.includes('### Assessment A: Design Review'))
    assert.ok(out.includes('## Reference Material'))
    assert.ok(out.includes('### Heuristics Scoring Guide'))
  })

  test('drops Assessment B, which points at a launcher path that does not exist here', () => {
    const out = stripSections(CRITIQUE)
    assert.ok(!out.includes('### Assessment B'))
    assert.ok(!out.includes('impeccable live-server'))
    assert.ok(
      !out.includes('.claude/skills/impeccable/scripts/impeccable detect'),
      'the agent must never be told to exec a path we do not ship'
    )
  })

  test('a "#" inside a fenced code block is not treated as a heading', () => {
    const md = ['## Keep', 'text', '```bash', '# not a heading', 'echo hi', '```', 'more'].join(
      '\n'
    )
    const out = stripSections(md, [/^not a heading$/i])
    assert.ok(out.includes('# not a heading'), 'fenced content must survive')
    assert.ok(out.includes('echo hi'))
  })

  test('is a no-op when nothing matches', () => {
    const md = '## Alpha\n\nbody\n\n## Beta\n\nbody'
    assert.ok(stripSections(md, [/^nothing$/]).includes('## Alpha'))
    assert.ok(stripSections(md, [/^nothing$/]).includes('## Beta'))
  })
})

// ── truncateToSections ───────────────────────────────────────────────────────

describe('truncateToSections', () => {
  test('returns the input unchanged when it already fits', () => {
    const md = '## A\n\nshort'
    assert.equal(truncateToSections(md, 10_000), md)
  })

  test('cuts on a section boundary and flags the truncation', () => {
    const md = `## A\n\n${'a'.repeat(400)}\n\n## B\n\n${'b'.repeat(400)}`
    const out = truncateToSections(md, 500)
    assert.ok(out.length <= 500)
    assert.ok(out.includes('## A'))
    assert.ok(!out.includes('## B'), 'must not include a section that does not fit')
    assert.match(out, /truncated/i)
  })

  test('still yields something when a single section exceeds the whole budget', () => {
    const out = truncateToSections(`## Huge\n\n${'x'.repeat(5000)}`, 300)
    assert.ok(out.length <= 300)
    assert.ok(out.length > 0)
  })
})

// ── assembleImpeccableLayer ──────────────────────────────────────────────────

describe('assembleImpeccableLayer', () => {
  test('stays under the hard cap for the worst-case command', () => {
    // Inflate the fixture well past the real 42.7 KB critique playbook.
    const oversized = CRITIQUE + '\n\n### Filler\n\n' + 'x'.repeat(100_000)
    const layer = assembleImpeccableLayer('critique', SKILL, oversized)
    assert.ok(
      layer.length <= MAX_IMPECCABLE_LAYER_CHARS,
      `layer was ${layer.length}, cap is ${MAX_IMPECCABLE_LAYER_CHARS}`
    )
  })

  test('caps every command even with a pathological playbook', () => {
    const huge = '## Section\n\n' + 'y'.repeat(60_000)
    for (const id of ['audit', 'critique', 'polish', 'harden', 'animate']) {
      const layer = assembleImpeccableLayer(id, SKILL, huge)
      assert.ok(layer.length <= MAX_IMPECCABLE_LAYER_CHARS, `${id} exceeded the cap`)
    }
  })

  test('labels the playbook with the command id', () => {
    const layer = assembleImpeccableLayer('audit', SKILL, AUDIT)
    assert.ok(layer.includes('`audit` playbook'))
  })

  test('strips YAML frontmatter from SKILL.md', () => {
    const layer = assembleImpeccableLayer('audit', SKILL, AUDIT)
    assert.ok(!layer.includes('user-invocable:'))
    assert.ok(!layer.includes('license: Apache'))
  })

  test('degrades to an empty layer when nothing is provisioned', () => {
    assert.equal(assembleImpeccableLayer('audit', null, null), '')
  })

  test('works with only the playbook available', () => {
    const layer = assembleImpeccableLayer('audit', null, AUDIT)
    assert.ok(layer.includes('Diagnostic Scan'))
    assert.ok(layer.length <= MAX_IMPECCABLE_LAYER_CHARS)
  })
})

// ── renderDesignPrompt ───────────────────────────────────────────────────────

function params(overrides: Partial<DesignPromptParams> = {}): DesignPromptParams {
  return {
    commandId: 'critique',
    commandName: 'Critique',
    commandDescription: 'UX evaluation of visual hierarchy.',
    workspaceName: 'Sample App',
    detectedTechs: ['React', 'TypeScript'],
    brief: '',
    scopeMode: 'project',
    scopePaths: [],
    refineCommands: [],
    impeccableLayer: '',
    ...overrides
  }
}

describe('renderDesignPrompt', () => {
  test('preserves the audit output contract so parseAuditResponse still works', () => {
    const p = renderDesignPrompt(params())
    assert.ok(p.includes('```audit-finding'))
    assert.ok(p.includes('```audit-score'))
  })

  test('states the read-only constraint', () => {
    const p = renderDesignPrompt(params())
    assert.match(p, /Do NOT modify, create, or delete any file/)
  })

  test('includes the user brief when present', () => {
    const p = renderDesignPrompt(params({ brief: 'I want to animate the user page' }))
    assert.ok(p.includes('I want to animate the user page'))
    assert.ok(p.includes('## What the user wants'))
  })

  test('omits the brief section entirely when the brief is blank', () => {
    assert.ok(!renderDesignPrompt(params({ brief: '   ' })).includes('## What the user wants'))
  })

  test('lists explicit scope paths', () => {
    const p = renderDesignPrompt(
      params({ scopeMode: 'paths', scopePaths: ['src/pages/Login.tsx', 'src/app.css'] })
    )
    assert.ok(p.includes('src/pages/Login.tsx'))
    assert.ok(p.includes('src/app.css'))
  })

  test('says "whole project" for project scope', () => {
    assert.ok(renderDesignPrompt(params()).includes('The whole project.'))
  })

  test('mentions refine commands as follow-up intent, not as this pass', () => {
    const p = renderDesignPrompt(params({ refineCommands: ['animate', 'polish'] }))
    assert.ok(p.includes('animate'))
    assert.ok(p.includes('NOT part of this pass'))
  })

  test('injects design context files when present', () => {
    const p = renderDesignPrompt(
      params({ productMd: 'We sell shoes.', designMd: 'Use warm neutrals.' })
    )
    assert.ok(p.includes('We sell shoes.'))
    assert.ok(p.includes('Use warm neutrals.'))
  })

  test('tells the agent not to invent a design system when context is missing', () => {
    const p = renderDesignPrompt(params())
    assert.match(p, /do not invent a design system/i)
  })

  test('instructs the agent not to re-report detector findings', () => {
    const p = renderDesignPrompt(params({ detectorSummary: '- Side-tab accent border (a.css)' }))
    assert.ok(p.includes('Side-tab accent border'))
    assert.match(p, /Do NOT re-report them/)
  })

  test('omits the detector section when there is nothing to report', () => {
    assert.ok(!renderDesignPrompt(params()).includes('Deterministic detector results'))
  })

  test('uses per-command scoring criteria', () => {
    assert.ok(renderDesignPrompt(params({ commandId: 'critique' })).includes('Cognitive load'))
    assert.ok(
      renderDesignPrompt(params({ commandId: 'audit', commandName: 'Audit' })).includes(
        'Accessibility'
      )
    )
  })

  test('appends round context for continuation rounds', () => {
    const p = renderDesignPrompt(
      params({
        roundContext: {
          roundNumber: 2,
          fileBatch: ['src/b.tsx'],
          previousFindingsSummary: '3 findings',
          remainingFileCount: 7
        }
      })
    )
    assert.ok(p.includes('Round 2'))
    assert.ok(p.includes('src/b.tsx'))
    assert.ok(p.includes('7 files remain'))
  })
})

// ── getDesignScoringFocus ────────────────────────────────────────────────────

describe('getDesignScoringFocus', () => {
  test('audit exposes the five Impeccable diagnostic dimensions', () => {
    assert.equal(getDesignScoringFocus('audit').length, 5)
  })

  test('falls back to generic criteria for a refine command', () => {
    assert.ok(getDesignScoringFocus('polish').length > 0)
  })
})

// ── summarizeDetectorFindings ────────────────────────────────────────────────

describe('summarizeDetectorFindings', () => {
  test('returns empty string for no findings', () => {
    assert.equal(summarizeDetectorFindings([]), '')
  })

  test('caps the list and reports the overflow count', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `F${i}`, filePath: 'a.css' }))
    const out = summarizeDetectorFindings(many, 15)
    assert.ok(out.includes('and 25 more'))
    assert.equal(out.split('\n').length, 16)
  })
})

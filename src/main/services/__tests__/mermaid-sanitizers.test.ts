/**
 * Unit tests for src/shared/mermaid-sanitizers.ts
 *
 * Covers all audit findings: hyphenated IDs, single-quoted icons,
 * labeled edges, bracket-wrapped multi-node, identity aliases,
 * and full pipeline integration.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  splitIconNodeLines,
  fixIconSyntax,
  fixIconNames,
  sanitizeMermaid,
  ICON_ALIASES
} from '../../../shared/mermaid-sanitizers'

// ── splitIconNodeLines ───────────────────────────────────────────────────────

describe('splitIconNodeLines', () => {
  test('splits two concatenated @{} nodes onto separate lines', () => {
    const input = 'A@{ icon: "lucide:home" }B@{ icon: "lucide:star" }'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('A@{ icon: "lucide:home" }\n'), 'first node should end with newline')
    assert.ok(result.includes('B@{ icon: "lucide:star" }'), 'second node should be on its own line')
  })

  test('splits three concatenated @{} nodes', () => {
    const input = 'A@{ icon: "lucide:home" }B@{ icon: "lucide:star" }C@{ icon: "lucide:sun" }'
    const result = splitIconNodeLines(input)
    const lines = result
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    assert.equal(lines.length, 3, 'should produce 3 separate lines')
  })

  test('splits hyphenated node IDs (step-1@{...}step-2@{...})', () => {
    const input = 'step-1@{ icon: "lucide:home" }step-2@{ icon: "lucide:star" }'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split at the closing brace')
    assert.ok(result.includes('step-2@{'), 'hyphenated ID should be preserved')
  })

  test('splits arrow trailing @{} node (-->)', () => {
    const input = 'A@{ icon: "lucide:home" } --> B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before arrow')
    assert.ok(result.includes('-->'), 'arrow should be on next line')
  })

  test('splits thick arrow trailing @{} node (==>)', () => {
    const input = 'A@{ icon: "lucide:home" } ==> B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before thick arrow')
    assert.ok(result.includes('==>'), 'thick arrow should be on next line')
  })

  test('splits labeled edge trailing @{} node (--text-->)', () => {
    const input = 'A@{ icon: "lucide:home" } --yes--> B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before labeled edge')
    assert.ok(result.includes('--yes-->'), 'labeled edge should be preserved')
  })

  test('splits dotted arrow trailing @{} node (-.->)', () => {
    const input = 'A@{ icon: "lucide:home" } -.-> B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before dotted arrow')
    assert.ok(result.includes('-.->'), 'dotted arrow should be on next line')
  })

  test('leaves already-correct input unchanged', () => {
    const input = 'A@{ icon: "lucide:home" }\n  B@{ icon: "lucide:star" }'
    const result = splitIconNodeLines(input)
    assert.equal(result, input)
  })

  test('handles @{} inside subgraph blocks', () => {
    const input = '  subgraph sub\n    A@{ icon: "lucide:home" }B@{ icon: "lucide:star" }\n  end'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should still split inside subgraph')
  })

  test('does not split non-icon closing braces (classDef, style)', () => {
    // classDef lines have } but no @{ after them
    const input = 'classDef default fill:#f9f,stroke:#333\nA --> B'
    const result = splitIconNodeLines(input)
    assert.equal(result, input, 'non-icon braces should not be affected')
  })

  test('splits reverse arrow trailing @{} node (<--)', () => {
    const input = 'A@{ icon: "lucide:home" } <-- B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before reverse arrow')
    assert.ok(result.includes('<--'), 'reverse arrow should be on next line')
  })

  test('splits tilde link trailing @{} node (~~~)', () => {
    const input = 'A@{ icon: "lucide:home" } ~~~ B'
    const result = splitIconNodeLines(input)
    assert.ok(result.includes('}\n'), 'should split before tilde link')
    assert.ok(result.includes('~~~'), 'tilde link should be on next line')
  })
})

// ── fixIconSyntax ────────────────────────────────────────────────────────────

describe('fixIconSyntax', () => {
  test('unwraps bracket-wrapped icon node A["@{...}"]', () => {
    const input = '  A["@{ icon: \\"lucide:home\\" }"]'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('A@{'), 'should unwrap brackets')
    assert.ok(!result.includes('["'), 'should remove bracket wrapper')
  })

  test('unwraps parenthesis-wrapped icon node A[("@{...}")]', () => {
    const input = '  B[("@{ icon: \\"lucide:star\\" }")]'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('B@{'), 'should unwrap parens+brackets')
  })

  test('converts :::className to class keyword', () => {
    const input = '  A["@{ icon: \\"lucide:home\\" }"]:::highlight'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('class A highlight'), 'should convert :::class to class keyword')
  })

  test('leaves correct @{} syntax unchanged', () => {
    const input = '  A@{ icon: "lucide:home" }'
    const result = fixIconSyntax(input)
    assert.equal(result, input)
  })

  test('leaves multiline @{} blocks unchanged', () => {
    const input = '  A@{\n    icon: "lucide:home",\n    label: "Home"\n  }'
    const result = fixIconSyntax(input)
    assert.equal(result, input, 'multiline @{} should not be collapsed')
  })

  test('unwraps form:-first bracket-wrapped node', () => {
    const input = '  A["@{ form: circle, icon: \"lucide:home\" }"]'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('A@{'), 'should unwrap brackets with form: first')
    assert.ok(result.includes('form: circle'), 'should preserve form: property')
  })

  test('unwraps bracket-wrapped node after arrow (mid-line)', () => {
    const input = '  X --> A["@{ icon: \"lucide:home\" }"]'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('A@{'), 'should unwrap mid-line bracket-wrapped node')
    assert.ok(!result.includes('["'), 'brackets should be removed')
  })

  test('unwraps two concatenated bracket-wrapped nodes', () => {
    const input = '  A["@{ icon: \"lucide:home\" }"]B["@{ icon: \"lucide:star\" }"]'
    const result = fixIconSyntax(input)
    assert.ok(result.includes('A@{'), 'first node should be unwrapped')
    assert.ok(result.includes('B@{'), 'second node should be unwrapped')
  })
})

// ── fixIconNames ─────────────────────────────────────────────────────────────

describe('fixIconNames', () => {
  test('remaps alert-triangle to triangle-alert', () => {
    const input = 'icon: "lucide:alert-triangle"'
    const result = fixIconNames(input)
    assert.equal(result, 'icon: "lucide:triangle-alert"')
  })

  test('remaps multiple icons on different lines', () => {
    const input = 'icon: "lucide:alert-triangle"\nicon: "lucide:home"'
    const result = fixIconNames(input)
    assert.ok(result.includes('lucide:triangle-alert'), 'alert-triangle → triangle-alert')
    assert.ok(result.includes('lucide:house'), 'home → house')
  })

  test('normalizes single quotes to double quotes', () => {
    const input = "icon: 'lucide:alert-triangle'"
    const result = fixIconNames(input)
    assert.equal(result, 'icon: "lucide:triangle-alert"')
  })

  test('does not touch non-lucide icons (mdi:...)', () => {
    const input = 'icon: "mdi:home"'
    const result = fixIconNames(input)
    assert.equal(result, input, 'non-lucide icons should not be modified')
  })

  test('handles extra whitespace after icon:', () => {
    const input = 'icon:   "lucide:edit"'
    const result = fixIconNames(input)
    assert.equal(result, 'icon: "lucide:square-pen"')
  })

  test('leaves valid icon names unchanged', () => {
    const input = 'icon: "lucide:star"'
    const result = fixIconNames(input)
    assert.equal(result, 'icon: "lucide:star"')
  })

  test('no identity no-op aliases remain in ICON_ALIASES', () => {
    for (const [key, value] of Object.entries(ICON_ALIASES)) {
      assert.notEqual(key, value, `identity alias found: ${key} → ${value}`)
    }
  })
})

// ── sanitizeMermaid (integration) ────────────────────────────────────────────

describe('sanitizeMermaid', () => {
  test('full pipeline: concat nodes + deprecated icon + arrow on same line', () => {
    const input = 'A@{ icon: "lucide:alert-triangle" }B@{ icon: "lucide:home" } --> C'
    const result = sanitizeMermaid(input)
    assert.ok(result.includes('lucide:triangle-alert'), 'should remap alert-triangle')
    assert.ok(result.includes('lucide:house'), 'should remap home')
    // Nodes should be on separate lines
    const lines = result.split('\n')
    assert.ok(lines.length >= 3, `expected at least 3 lines, got ${lines.length}`)
  })

  test('idempotent: running twice produces same result', () => {
    const input = 'A@{ icon: "lucide:alert-triangle" }B@{ icon: "lucide:home" } --> C'
    const once = sanitizeMermaid(input)
    const twice = sanitizeMermaid(once)
    assert.equal(once, twice, 'sanitizeMermaid should be idempotent')
  })

  test('trims leading/trailing whitespace', () => {
    const input = '  \n  A --> B  \n  '
    const result = sanitizeMermaid(input)
    assert.equal(result, 'A --> B')
  })

  test('full pipeline: bracket-wrapped + concatenated nodes', () => {
    const input = '  A["@{ icon: \"lucide:home\" }"]B["@{ icon: \"lucide:star\" }"]'
    const result = sanitizeMermaid(input)
    const lines = result
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    assert.ok(lines.length >= 2, 'concatenated bracket-wrapped nodes should be split')
    assert.ok(result.includes('A@{'), 'first node unwrapped')
    assert.ok(result.includes('B@{'), 'second node unwrapped')
  })

  test('preserves valid multiline diagram unchanged', () => {
    const input =
      'flowchart TD\n  A@{\n    icon: "lucide:house",\n    label: "Home"\n  }\n  B@{\n    icon: "lucide:star"\n  }\n  A --> B'
    const result = sanitizeMermaid(input)
    assert.equal(result, input, 'valid multiline diagram should pass through unchanged')
  })
})

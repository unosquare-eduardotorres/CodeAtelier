/**
 * Name -> Lucide component resolution for model-supplied icon ids.
 *
 * Regression: emit_plan's sections[].icon is a free string and the model fills
 * it with a Lucide id. TaskPlanSections rendered that string directly, so plan
 * cards showed the literal text "alert-triangle" / "alert-circle" / "list"
 * where an icon belonged.
 *
 * The load-bearing property is the last group: an id-shaped string must NEVER
 * come back as null, because null is what makes the caller print it as text.
 *
 * Run: tsx src/renderer/src/utils/__tests__/lucide-icon-by-name.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { lucideIconByName, looksLikeIconName } from '../lucideIconByName'

describe('lucideIconByName — the ids seen on the broken cards', () => {
  test('alert-triangle resolves', () => {
    assert.ok(lucideIconByName('alert-triangle'))
  })

  test('alert-circle resolves', () => {
    assert.ok(lucideIconByName('alert-circle'))
  })

  test('list resolves', () => {
    assert.ok(lucideIconByName('list'))
  })
})

describe('lucideIconByName — accepted spellings', () => {
  test('kebab-case', () => {
    assert.ok(lucideIconByName('file-text'))
  })

  test('PascalCase', () => {
    assert.ok(lucideIconByName('FileText'))
  })

  test('camelCase', () => {
    assert.ok(lucideIconByName('fileText'))
  })

  test('snake_case', () => {
    assert.ok(lucideIconByName('file_text'))
  })

  test('namespaced, as the mermaid guidance writes it', () => {
    assert.ok(lucideIconByName('lucide:list-checks'))
  })

  test('surrounding whitespace', () => {
    assert.ok(lucideIconByName('  list-checks  '))
  })

  test('every spelling of one id resolves to the same component', () => {
    const a = lucideIconByName('file-text')
    assert.equal(lucideIconByName('FileText'), a)
    assert.equal(lucideIconByName('file_text'), a)
    assert.equal(lucideIconByName('lucide:file-text'), a)
  })
})

describe('lucideIconByName — lucide 1.x renames', () => {
  // Models emit the pre-1.x names; both spellings must land somewhere.
  test('legacy alert-triangle and current triangle-alert both resolve', () => {
    assert.ok(lucideIconByName('alert-triangle'))
    assert.ok(lucideIconByName('triangle-alert'))
  })

  test('legacy check-circle and current circle-check both resolve', () => {
    assert.ok(lucideIconByName('check-circle'))
    assert.ok(lucideIconByName('circle-check'))
  })
})

describe('lucideIconByName — aliases', () => {
  test('semantic words map to a sensible icon', () => {
    assert.equal(lucideIconByName('warning'), lucideIconByName('triangle-alert'))
    assert.equal(lucideIconByName('tasks'), lucideIconByName('list-checks'))
    assert.equal(lucideIconByName('security'), lucideIconByName('shield'))
  })
})

describe('lucideIconByName — emoji stay text', () => {
  // Plans persisted before this change put an emoji in the same field, and
  // returning a component for them would replace the author's glyph.
  for (const emoji of ['📋', '⚠️', '🚀', '✅', '🔧']) {
    test(`${emoji} returns null so the caller renders it as text`, () => {
      assert.equal(lucideIconByName(emoji), null)
    })
  }

  test('empty and nullish return null', () => {
    assert.equal(lucideIconByName(''), null)
    assert.equal(lucideIconByName(undefined), null)
    assert.equal(lucideIconByName(null), null)
    assert.equal(lucideIconByName('   '), null)
  })
})

describe('lucideIconByName — unknown ids never leak as text', () => {
  test('an unknown but id-shaped name falls back to a component', () => {
    assert.ok(lucideIconByName('definitely-not-a-real-icon'))
  })

  test('the fallback is overridable', () => {
    const custom = lucideIconByName('list')!
    assert.equal(lucideIconByName('nope-not-real', custom), custom)
  })

  test('no id-shaped string returns null', () => {
    const ids = [
      'alert-triangle',
      'list',
      'gears',
      'some-made-up-thing',
      'X',
      'a1-b2',
      'Refactor',
      'lucide:whatever'
    ]
    for (const id of ids) {
      assert.ok(lucideIconByName(id), `${id} must not fall through to text`)
    }
  })
})

describe('looksLikeIconName', () => {
  test('true for identifiers', () => {
    for (const v of ['list', 'alert-triangle', 'FileText', 'lucide:list', 'file_text']) {
      assert.equal(looksLikeIconName(v), true, v)
    }
  })

  test('false for emoji and punctuation-only strings', () => {
    for (const v of ['📋', '⚠️', '', '   ', '->', '123']) {
      assert.equal(looksLikeIconName(v), false, v)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

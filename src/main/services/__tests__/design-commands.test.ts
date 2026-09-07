/**
 * Unit tests for src/shared/design-commands.ts
 *
 * Covers catalogue integrity (the invariants the wizard and the remediation
 * brief both rely on), the incompatibility matrix, and the scope/extension
 * helpers.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  DESIGN_BRIEF_EXAMPLES,
  DESIGN_COMMANDS,
  DESIGN_COMMANDS_BY_ID,
  EVALUATE_COMMAND_IDS,
  IMPECCABLE_DESIGN_EXTENSIONS,
  evaluateCommandsSelected,
  getDesignCommand,
  isDesignRelevantPath,
  refineCommandsSelected,
  validateDesignCommandSet
} from '../../../shared/design-commands'
import type { DesignCommandId } from '../../../shared/types'

// ── Catalogue integrity ──────────────────────────────────────────────────────

describe('DESIGN_COMMANDS catalogue', () => {
  test('contains exactly 16 commands', () => {
    assert.equal(DESIGN_COMMANDS.length, 16)
  })

  test('ids are unique', () => {
    const ids = DESIGN_COMMANDS.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate command id in the catalogue')
  })

  test('exactly two evaluate commands, and they are audit + critique', () => {
    const evaluate = DESIGN_COMMANDS.filter((c) => c.category === 'evaluate').map((c) => c.id)
    assert.deepEqual(evaluate, ['audit', 'critique'])
    assert.deepEqual([...EVALUATE_COMMAND_IDS], ['audit', 'critique'])
  })

  test('every command carries a non-empty name, description and impeccableCommand', () => {
    for (const c of DESIGN_COMMANDS) {
      assert.ok(c.name.length > 0, `${c.id} has no name`)
      assert.ok(c.description.length > 0, `${c.id} has no description`)
      assert.ok(c.impeccableCommand.length > 0, `${c.id} has no impeccableCommand`)
    }
  })

  test('impeccableCommand matches the card id for every command', () => {
    // The remediation brief and any future engine invocation both key off this;
    // a divergence would silently route findings to a non-existent command.
    for (const c of DESIGN_COMMANDS) {
      assert.equal(c.impeccableCommand, c.id, `${c.id} routes to ${c.impeccableCommand}`)
    }
  })

  test('excludes the commands that are deliberately not cards', () => {
    const ids = new Set(DESIGN_COMMANDS.map((c) => c.id as string))
    for (const excluded of ['shape', 'init', 'document', 'extract', 'live', 'craft', 'overdrive']) {
      assert.ok(!ids.has(excluded), `${excluded} must not be a selectable card`)
    }
  })

  test('incompatibleWith only references real ids, never itself', () => {
    const ids = new Set(DESIGN_COMMANDS.map((c) => c.id as string))
    for (const c of DESIGN_COMMANDS) {
      for (const other of c.incompatibleWith) {
        assert.ok(ids.has(other), `${c.id} references unknown id ${other}`)
        assert.notEqual(other, c.id, `${c.id} is incompatible with itself`)
      }
    }
  })

  test('the incompatibility matrix is symmetric', () => {
    // An asymmetric entry means the conflict only appears when the user picks
    // the pair in one order — the classic way a "blocked" combination ships.
    for (const c of DESIGN_COMMANDS) {
      for (const other of c.incompatibleWith) {
        const def = DESIGN_COMMANDS_BY_ID[other]
        assert.ok(
          def.incompatibleWith.includes(c.id),
          `${c.id} → ${other} is not mirrored by ${other} → ${c.id}`
        )
      }
    }
  })

  test('evaluate commands are compatible with everything', () => {
    for (const c of DESIGN_COMMANDS) {
      if (c.category !== 'evaluate') continue
      assert.deepEqual(c.incompatibleWith, [], `${c.id} must combine freely`)
    }
    for (const c of DESIGN_COMMANDS) {
      for (const e of EVALUATE_COMMAND_IDS) {
        assert.ok(!c.incompatibleWith.includes(e), `${c.id} must not exclude ${e}`)
      }
    }
  })

  test('getDesignCommand resolves known ids and rejects unknown ones', () => {
    assert.equal(getDesignCommand('polish')?.name, 'Polish')
    assert.equal(getDesignCommand('overdrive'), undefined)
  })
})

// ── validateDesignCommandSet ─────────────────────────────────────────────────

describe('validateDesignCommandSet', () => {
  test('an empty set is valid', () => {
    assert.deepEqual(validateDesignCommandSet([]), { valid: true, conflicts: [] })
  })

  test('the documented evaluate pair is valid', () => {
    assert.equal(validateDesignCommandSet(['audit', 'critique']).valid, true)
  })

  test('bolder + quieter conflicts (two halves of voice)', () => {
    const r = validateDesignCommandSet(['bolder', 'quieter'])
    assert.equal(r.valid, false)
    assert.deepEqual(r.conflicts, [['bolder', 'quieter']])
  })

  test('the conflict is reported once, not once per direction', () => {
    const r = validateDesignCommandSet(['quieter', 'bolder'])
    assert.equal(r.conflicts.length, 1, 'a single clash must yield a single badge')
    assert.deepEqual(
      r.conflicts,
      [['bolder', 'quieter']],
      'pairs are normalised to catalogue order'
    )
  })

  test('distill conflicts with each additive command', () => {
    for (const additive of ['animate', 'bolder', 'colorize', 'delight'] as DesignCommandId[]) {
      const r = validateDesignCommandSet(['distill', additive])
      assert.equal(r.valid, false, `distill + ${additive} should conflict`)
    }
  })

  test('distill with several additive commands reports every pair', () => {
    const r = validateDesignCommandSet(['distill', 'animate', 'colorize'])
    assert.equal(r.valid, false)
    assert.equal(r.conflicts.length, 2)
  })

  test('a compatible refine combination is valid', () => {
    assert.equal(validateDesignCommandSet(['polish', 'typeset', 'layout', 'harden']).valid, true)
  })

  test('distill is compatible with non-additive refine commands', () => {
    assert.equal(validateDesignCommandSet(['distill', 'clarify', 'polish']).valid, true)
  })

  test('unknown ids are ignored and never mask a real conflict', () => {
    const r = validateDesignCommandSet(['nonsense', 'bolder', 'quieter'])
    assert.equal(r.valid, false)
    assert.deepEqual(r.conflicts, [['bolder', 'quieter']])
  })

  test('a duplicated id does not manufacture a self-conflict', () => {
    assert.equal(validateDesignCommandSet(['polish', 'polish']).valid, true)
  })

  test('every catalogue command is valid on its own', () => {
    for (const c of DESIGN_COMMANDS) {
      assert.equal(validateDesignCommandSet([c.id]).valid, true, `${c.id} alone should be valid`)
    }
  })
})

// ── selection partitioning ───────────────────────────────────────────────────

describe('evaluateCommandsSelected / refineCommandsSelected', () => {
  test('splits a mixed selection into what runs and what only routes', () => {
    const sel = ['critique', 'polish', 'audit', 'distill']
    assert.deepEqual(evaluateCommandsSelected(sel), ['audit', 'critique'])
    assert.deepEqual(refineCommandsSelected(sel), ['distill', 'polish'])
  })

  test('returns empty arrays for an empty selection', () => {
    assert.deepEqual(evaluateCommandsSelected([]), [])
    assert.deepEqual(refineCommandsSelected([]), [])
  })

  test('a refine-only selection runs nothing', () => {
    assert.deepEqual(evaluateCommandsSelected(['polish', 'harden']), [])
  })

  test('ignores unknown ids', () => {
    assert.deepEqual(evaluateCommandsSelected(['audit', 'bogus']), ['audit'])
  })
})

// ── scope helpers ────────────────────────────────────────────────────────────

describe('isDesignRelevantPath', () => {
  test('accepts the web/UI extensions the detector reads', () => {
    for (const p of [
      'src/App.tsx',
      'src/app.jsx',
      'index.html',
      'styles/main.css',
      'a/b/c.scss',
      'Widget.vue',
      'Page.svelte',
      'home.astro'
    ]) {
      assert.ok(isDesignRelevantPath(p), `${p} should be design-relevant`)
    }
  })

  test('rejects backend and non-UI files', () => {
    for (const p of [
      'server.ts',
      'main.py',
      'schema.sql',
      'README.md',
      'data.json',
      'Cargo.toml'
    ]) {
      assert.ok(!isDesignRelevantPath(p), `${p} should not be design-relevant`)
    }
  })

  test('is case-insensitive', () => {
    assert.ok(isDesignRelevantPath('Component.TSX'))
  })

  test('does not match an extension appearing mid-path', () => {
    assert.ok(!isDesignRelevantPath('src/css/readme.txt'))
  })

  test('extension list is non-empty and every entry starts with a dot', () => {
    assert.ok(IMPECCABLE_DESIGN_EXTENSIONS.length > 0)
    for (const ext of IMPECCABLE_DESIGN_EXTENSIONS) {
      assert.ok(ext.startsWith('.'), `${ext} should start with '.'`)
    }
  })
})

describe('DESIGN_BRIEF_EXAMPLES', () => {
  test('provides several non-empty, unique chips', () => {
    assert.ok(DESIGN_BRIEF_EXAMPLES.length >= 3)
    assert.equal(new Set(DESIGN_BRIEF_EXAMPLES).size, DESIGN_BRIEF_EXAMPLES.length)
    for (const e of DESIGN_BRIEF_EXAMPLES) assert.ok(e.trim().length > 0)
  })
})

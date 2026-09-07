/**
 * T003 fix — venv-interpreter rewrite against the SOURCE workspace.
 *
 * The TASKS-declared command `multiplexer/.venv-mux/Scripts/python.exe -m
 * unittest …` resolves against the worktree cwd, where the gitignored venv
 * never exists. The rewrite rebinds it to the source checkout — the exact
 * design `findVenvPython` established for root-level venvs, generalized to
 * nested custom-named ones.
 *
 * Run: tsx src/main/services/__tests__/gate-command-rewrite.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import {
  rewriteVenvInterpreter,
  isVenvInterpreterToken
} from '../../../shared/gate-command-rewrite'

const tempDirs: string[] = []

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Create the file a venv "interpreter" would live at (a stub is enough — only existence matters). */
function makeVenv(root: string, rel: string): string {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, '#!/bin/sh\n# stub interpreter\n')
  return abs
}

describe('isVenvInterpreterToken — the venv shape detector', () => {
  test('Windows nested custom-named venv matches', () => {
    assert.ok(isVenvInterpreterToken('multiplexer/.venv-mux/Scripts/python.exe'))
  })
  test('root .venv (win + posix) matches', () => {
    assert.ok(isVenvInterpreterToken('.venv/Scripts/python.exe'))
    assert.ok(isVenvInterpreterToken('.venv/bin/python'))
  })
  test('custom-named posix venv (venv-mux, venv311) matches', () => {
    assert.ok(isVenvInterpreterToken('venv-mux/bin/python'))
    assert.ok(isVenvInterpreterToken('services/api/venv311/bin/python3'))
  })
  test('python2 variant matches', () => {
    assert.ok(isVenvInterpreterToken('.venv/bin/python2'))
  })
  test('bare commands and non-venv paths do NOT match', () => {
    assert.ok(!isVenvInterpreterToken('pytest'))
    assert.ok(!isVenvInterpreterToken('npm'))
    assert.ok(!isVenvInterpreterToken('node_modules/.bin/vitest'))
    assert.ok(!isVenvInterpreterToken('src/main.py'))
    assert.ok(!isVenvInterpreterToken('/usr/bin/python3'))
  })
})

describe('rewriteVenvInterpreter — source-workspace rebinding', () => {
  test('nested declared venv existing under sourceRoot → rewritten to absolute source path', () => {
    const source = tempRoot('gcr-src-')
    const worktree = tempRoot('gcr-wt-')
    const abs = makeVenv(source, 'multiplexer/.venv-mux/Scripts/python.exe')
    const cmd = 'multiplexer/.venv-mux/Scripts/python.exe -m unittest discover -s tests'
    const out = rewriteVenvInterpreter(cmd, { sourceRoot: source, worktreeRoot: worktree })
    assert.equal(out.rewritten, true)
    assert.equal(
      out.command,
      `${abs} -m unittest discover -s tests`,
      'the rest of the command must survive byte-identical'
    )
  })

  test('venv nonexistent EVERYWHERE → unchanged, rewritten:false (must stay visible for the gate to report)', () => {
    const source = tempRoot('gcr-src2-')
    const worktree = tempRoot('gcr-wt2-')
    const cmd = '.venv/Scripts/python.exe -m pytest'
    const out = rewriteVenvInterpreter(cmd, { sourceRoot: source, worktreeRoot: worktree })
    assert.equal(out.rewritten, false)
    assert.equal(
      out.command,
      cmd,
      'a nonexistent-everywhere interpreter must not be silently masked'
    )
  })

  test('bare pytest/npm are untouched', () => {
    const source = tempRoot('gcr-src3-')
    for (const cmd of ['pytest tests/', 'npm test', 'uv run pytest']) {
      const out = rewriteVenvInterpreter(cmd, { sourceRoot: source, worktreeRoot: source })
      assert.equal(out.rewritten, false)
      assert.equal(out.command, cmd)
    }
  })

  test('POSIX bin/python variant rewrites', () => {
    const source = tempRoot('gcr-src4-')
    const abs = makeVenv(source, '.venv/bin/python')
    const out = rewriteVenvInterpreter('.venv/bin/python -m pytest tests/a.py', {
      sourceRoot: source,
      worktreeRoot: tempRoot('gcr-wt4-')
    })
    assert.equal(out.rewritten, true)
    assert.equal(out.command, `${abs} -m pytest tests/a.py`)
  })

  // T003/G3 — a source root containing spaces must produce a QUOTED absolute
  // replacement, or the shell splits the interpreter path into two arguments
  // and the gate grades a spawn failure as a red suite. The quoted command
  // round-trips through `parseStopLossCommand` (parens, not quotes, delimit it)
  // and passes `isSafeGateCommand` (quotes are not forbidden metacharacters).
  test('source root WITH SPACES → rewritten path is quoted and round-trips', () => {
    const source = join(tempRoot('gcr-src-spaces-'), 'My Projects', 'Redshift Agent')
    const abs = makeVenv(source, 'multiplexer/.venv-mux/Scripts/python.exe')
    const cmd = 'multiplexer/.venv-mux/Scripts/python.exe -m unittest discover -s tests'
    const out = rewriteVenvInterpreter(cmd, {
      sourceRoot: source,
      worktreeRoot: tempRoot('gcr-wt-spaces-')
    })
    assert.equal(out.rewritten, true)
    assert.equal(out.command, `"${abs}" -m unittest discover -s tests`)

    // Round-trip: the stop-loss suffix must recover the exact quoted string.
    const { formatStopLossCommandSuffix, parseStopLossCommand } =
      require('../blueprint-stop-loss') as typeof import('../blueprint-stop-loss')
    const reason = `stop-loss after 2 identical gate failure(s) (task-tests)${formatStopLossCommandSuffix(out.command)}`
    assert.equal(parseStopLossCommand(reason), out.command)
  })

  test('absolute venv token that EXISTS → untouched (already machine-bound)', () => {
    const source = tempRoot('gcr-src5-')
    const abs = makeVenv(source, '.venv/bin/python')
    const out = rewriteVenvInterpreter(`${abs} -m pytest`, {
      sourceRoot: source,
      worktreeRoot: source
    })
    assert.equal(out.rewritten, false)
    assert.equal(out.command, `${abs} -m pytest`)
  })

  test('absolute venv token that does NOT exist but the same suffix exists under source → rebound', () => {
    const source = tempRoot('gcr-src6-')
    const abs = makeVenv(source, 'proj/.venv/bin/python')
    const stale = '/old-home/dead-machines/proj/.venv/bin/python'
    const out = rewriteVenvInterpreter(`${stale} -m pytest`, {
      sourceRoot: source,
      worktreeRoot: source
    })
    assert.equal(out.rewritten, true)
    assert.equal(out.command, `${abs} -m pytest`)
  })

  test('absolute venv token dead everywhere → unchanged (honest failure path)', () => {
    const out = rewriteVenvInterpreter('/no/such/.venv/bin/python -m pytest', {
      sourceRoot: tempRoot('gcr-src7-'),
      worktreeRoot: tempRoot('gcr-wt7-')
    })
    assert.equal(out.rewritten, false)
    assert.equal(out.command, '/no/such/.venv/bin/python -m pytest')
  })

  test('worktree-only venv (exists in worktree but not source) → not rewritten by source rule', () => {
    // A venv present in the WORKTREE but not the source is unusual (gitignored)
    // but the rewrite must not touch it — only the source copy is the rebind
    // target, and the command already resolves where it runs.
    const source = tempRoot('gcr-src8-')
    const worktree = tempRoot('gcr-wt8-')
    makeVenv(worktree, '.venv/bin/python')
    const cmd = '.venv/bin/python -m pytest'
    const out = rewriteVenvInterpreter(cmd, { sourceRoot: source, worktreeRoot: worktree })
    assert.equal(out.rewritten, false)
    assert.equal(out.command, cmd)
  })
})

process.on('exit', () => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

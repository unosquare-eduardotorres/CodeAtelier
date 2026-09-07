/**
 * T003 fix — rewrite declared venv-interpreter paths against the SOURCE workspace.
 *
 * A TASKS-declared test command like
 *   `multiplexer/.venv-mux/Scripts/python.exe -m unittest …`
 * resolves against the command's cwd — inside a blueprint git worktree, where
 * every venv is absent (`.venv*` is .gitignored, so it is never checked out).
 * The venv lives in the SOURCE checkout. `findVenvPython` already established
 * that design for root-level `.venv`/`venv`; this module generalizes it to any
 * nested, custom-named venv path that appears as the command's first token.
 *
 * Reusing the source venv's interpreter with `cwd` = worktree is sound: a venv
 * python resolves its site-packages from its own home (`pyvenv.cfg`), never
 * from cwd (incident 2026-08 comment on `findVenvPython`).
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { quoteIfNeeded } from './gate-command-detect'

/**
 * Matches a token that is a path to a venv's python interpreter, covering:
 *   `.venv`, `venv`, `venv-mux`, `.venv-mux`, `venv311`, `.virtualenv-foo`
 * on Windows (`Scripts/python.exe`) and POSIX (`bin/python`, `bin/python3`).
 */
const VENV_INTERPRETER_RE =
  /(^|[\\/])(\.[\w-]*venv[\w-]*|venv[\w-]*)[\\/](Scripts[\\/]python(\.exe)?|bin[\\/]python[23]?)$/i

/** True when a command token looks like a venv interpreter path. */
export function isVenvInterpreterToken(token: string): boolean {
  return VENV_INTERPRETER_RE.test(token)
}

export interface RewriteVenvOptions {
  /** The SOURCE checkout — where gitignored venvs actually live. */
  sourceRoot: string
  /** The blueprint worktree the command would otherwise resolve against. */
  worktreeRoot: string
}

export interface RewriteVenvResult {
  command: string
  /** True when the interpreter token was replaced. */
  rewritten: boolean
}

/**
 * Rewrite a command's venv-shaped interpreter token to the equivalent absolute
 * path under `sourceRoot` — only when that file actually exists there.
 *
 * Conservative by design:
 *  - Relative venv token, source copy exists → rewrite to the absolute path.
 *  - Relative venv token, no source copy → UNCHANGED (`rewritten: false`).
 *    A nonexistent-everywhere interpreter must stay visible so the gate (or the
 *    pre-dispatch check) reports it honestly instead of silently masking it.
 *  - Absolute venv token that exists → untouched (a working absolute path is
 *    already machine-bound; rewriting it would be gratuitous).
 *  - Absolute venv token that does NOT exist → rebind only when the same
 *    relative suffix exists under `sourceRoot` (machine-rebind edge).
 *  - Bare commands (`pytest`, `npm test`) → untouched.
 */
export function rewriteVenvInterpreter(
  command: string,
  opts: RewriteVenvOptions
): RewriteVenvResult {
  const trimmed = command.trimStart()
  // First whitespace-delimited token — quotes included in the token are handled
  // by requiring the venv suffix to END the token (a trailing quote fails RE).
  const m = /^(\S+)/.exec(trimmed)
  if (!m) return { command, rewritten: false }
  const token = m[1]
  if (!isVenvInterpreterToken(token)) return { command, rewritten: false }

  if (isAbsolute(token)) {
    if (existsSync(token)) return { command, rewritten: false }
    // Machine rebind: `/old-home/proj/.venv/bin/python` → `<sourceRoot>/…/.venv/bin/python`.
    // The stale absolute path embeds the OLD source root, which cannot be known,
    // so candidates are every suffix of the path that still has the venv shape —
    // longest first (most specific wins), all gated on existence.
    const segments = token.split(/[\\/]+/).filter(Boolean)
    for (let start = 0; start < segments.length - 1; start++) {
      const suffix = segments.slice(start).join('/')
      if (!isVenvInterpreterToken(suffix)) continue
      const sourceCandidate = join(opts.sourceRoot, suffix)
      if (existsSync(sourceCandidate)) {
        return {
          command: replaceFirstToken(command, token, quoteIfNeeded(sourceCandidate)),
          rewritten: true
        }
      }
    }
    return { command, rewritten: false }
  }

  const sourceCandidate = join(opts.sourceRoot, token)
  if (existsSync(sourceCandidate)) {
    return {
      command: replaceFirstToken(command, token, quoteIfNeeded(sourceCandidate)),
      rewritten: true
    }
  }
  return { command, rewritten: false }
}

function replaceFirstToken(command: string, token: string, replacement: string): string {
  const idx = command.indexOf(token)
  if (idx === -1) return command
  return command.slice(0, idx) + replacement + command.slice(idx + token.length)
}

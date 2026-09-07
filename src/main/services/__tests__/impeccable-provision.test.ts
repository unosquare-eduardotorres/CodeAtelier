/**
 * Unit tests for src/main/services/impeccable-provision.service.ts
 *
 * Uses a fake engine script (via IMPECCABLE_BIN) that reproduces the real
 * `install` contract verified against engine v0.1.3: it writes
 * `.claude/skills/impeccable/{SKILL.md,reference/*.md}` relative to its cwd and
 * exits 0. Each invocation appends to a counter file so we can assert the stamp
 * fast path really avoids the subprocess.
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, runExclusive } from './test-harness'
import { resetImpeccableRuntimeCache } from '../impeccable-runtime.service'
import {
  __setProvisionRootForTests,
  ensureProvisioned,
  getProvisionRoot,
  getProvisionState,
  getSkillDir,
  readCommandMarkdown,
  readSkillMarkdown
} from '../impeccable-provision.service'

const isWindows = process.platform === 'win32'

interface Fixture {
  root: string
  binDir: string
  counterFile: string
  cleanup: () => void
}

/** Engine version pinned by the service; the fake must agree for the fast path. */
const ENGINE_VERSION = '0.1.3'
const PKG_VERSION = '4.0.4'

function setup(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'impeccable-provision-'))
  const root = join(base, 'userData', 'impeccable-skill')
  const binDir = join(base, 'bin')
  const counterFile = join(base, 'invocations.log')
  mkdirSync(binDir, { recursive: true })

  const enginePath = join(binDir, 'engine')
  writeFileSync(
    enginePath,
    [
      '#!/bin/sh',
      `echo "$@" >> "${counterFile}"`,
      'if [ "$1" = "--version" ]; then',
      `  echo "${ENGINE_VERSION}"`,
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ]; then',
      '  mkdir -p .claude/skills/impeccable/reference',
      '  printf "# Impeccable SKILL\\n" > .claude/skills/impeccable/SKILL.md',
      '  printf "# critique playbook\\n" > .claude/skills/impeccable/reference/critique.md',
      '  exit 0',
      'fi',
      'exit 1',
      ''
    ].join('\n'),
    'utf-8'
  )
  chmodSync(enginePath, 0o755)

  const prevBin = process.env.IMPECCABLE_BIN
  process.env.IMPECCABLE_BIN = enginePath
  __setProvisionRootForTests(root)
  resetImpeccableRuntimeCache()

  return {
    root,
    binDir,
    counterFile,
    cleanup: () => {
      if (prevBin === undefined) delete process.env.IMPECCABLE_BIN
      else process.env.IMPECCABLE_BIN = prevBin
      __setProvisionRootForTests(null)
      resetImpeccableRuntimeCache()
      rmSync(base, { recursive: true, force: true })
    }
  }
}

function installCount(f: Fixture): number {
  try {
    return readFileSync(f.counterFile, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('install')).length
  } catch {
    return 0
  }
}

// ── ensureProvisioned ────────────────────────────────────────────────────────

describe('ensureProvisioned', () => {
  test('cold path installs the payload and reports ready', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        const res = await ensureProvisioned()
        assert.equal(res.status, 'ready', `expected ready, got ${res.status}: ${res.reason}`)
        assert.ok(existsSync(join(getSkillDir(), 'SKILL.md')), 'SKILL.md should exist')
        assert.equal(installCount(f), 1)
      } finally {
        f.cleanup()
      }
    }))

  test('passes the non-interactive flag set the engine requires', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        const line = readFileSync(f.counterFile, 'utf-8')
          .split('\n')
          .find((l) => l.startsWith('install'))
        assert.ok(line, 'expected an install invocation')
        // -y suppresses the TTY confirmation; --no-hooks keeps Impeccable's
        // edit-time hooks out of our agent sessions.
        assert.ok(line.includes('--providers=claude'), 'must scope the install to claude')
        assert.ok(line.includes('--scope=project'), 'must install project-scoped')
        assert.ok(line.includes('--no-hooks'), 'hooks are out of scope and must be disabled')
        assert.ok(line.includes('-y'), 'must run non-interactively')
      } finally {
        f.cleanup()
      }
    }))

  test('stamp fast path returns ready without spawning the engine again', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        assert.equal(installCount(f), 1)
        const second = await ensureProvisioned()
        assert.equal(second.status, 'ready')
        assert.equal(installCount(f), 1, 'second call must not re-run install')
      } finally {
        f.cleanup()
      }
    }))

  test('a version-mismatched stamp forces a reinstall', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        assert.equal(installCount(f), 1)
        writeFileSync(
          join(f.root, '.provision-stamp.json'),
          JSON.stringify({
            engineVersion: '0.0.1-old',
            pkgVersion: PKG_VERSION,
            installedAt: new Date().toISOString()
          }),
          'utf-8'
        )
        const res = await ensureProvisioned()
        assert.equal(res.status, 'ready')
        assert.equal(installCount(f), 2, 'stale engine version must trigger reinstall')
      } finally {
        f.cleanup()
      }
    }))

  test('a missing SKILL.md invalidates an otherwise-valid stamp', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        rmSync(join(getSkillDir(), 'SKILL.md'), { force: true })
        await ensureProvisioned()
        assert.equal(installCount(f), 2, 'payload deleted on disk must trigger reinstall')
      } finally {
        f.cleanup()
      }
    }))

  test('concurrent callers share one in-flight install', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        const results = await Promise.all([
          ensureProvisioned(),
          ensureProvisioned(),
          ensureProvisioned()
        ])
        for (const r of results) assert.equal(r.status, 'ready')
        assert.equal(installCount(f), 1, 'parallel calls must not race two installs')
      } finally {
        f.cleanup()
      }
    }))

  test('never writes outside the app-managed root', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      const cwdBefore = process.cwd()
      try {
        await ensureProvisioned()
        // The real risk this guards: installing into the user's repo and dirtying
        // their git status. The payload must live under the provision root only.
        assert.ok(
          getSkillDir().startsWith(getProvisionRoot()),
          'skill dir must be inside the provision root'
        )
        assert.ok(
          !existsSync(join(cwdBefore, '.claude', 'skills', 'impeccable', 'SKILL.md')),
          'provisioning must not write into the working directory'
        )
      } finally {
        f.cleanup()
      }
    }))

  test('an unavailable engine degrades to status:unavailable without throwing', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        // Drive the unavailable branch through a failing `--version` probe
        // rather than by making every resolution tier miss. Emptying PATH or
        // chdir-ing would leak into suites running concurrently, and the
        // bare-name PATH tier would otherwise find the real engine anyway
        // (npm puts node_modules/.bin on PATH).
        const dead = join(f.binDir, 'dead-engine')
        writeFileSync(dead, '#!/bin/sh\nexit 127\n', 'utf-8')
        chmodSync(dead, 0o755)
        process.env.IMPECCABLE_BIN = dead
        resetImpeccableRuntimeCache()
        const res = await ensureProvisioned()
        assert.equal(res.status, 'unavailable', `got ${res.status}: ${res.reason}`)
        assert.ok(res.reason, 'expected a diagnostic reason')
        assert.equal(installCount(f), 0, 'must not attempt an install when unavailable')
      } finally {
        f.cleanup()
      }
    }))

  test('an install that exits non-zero reports failed, not ready', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        const broken = join(f.binDir, 'broken')
        writeFileSync(
          broken,
          [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then echo 0.1.3; exit 0; fi',
            'exit 4',
            ''
          ].join('\n'),
          'utf-8'
        )
        chmodSync(broken, 0o755)
        process.env.IMPECCABLE_BIN = broken
        resetImpeccableRuntimeCache()
        const res = await ensureProvisioned()
        assert.equal(res.status, 'failed')
        assert.ok(res.reason?.includes('4'), `reason should carry the exit code: ${res.reason}`)
      } finally {
        f.cleanup()
      }
    }))

  test('a failure is not retried until the cooldown expires or force is passed', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        // `install` downloads its payload, so offline is the expected first-run
        // failure. Each attempt costs the full 60s timeout, so repeatedly
        // opening the wizard must not stack retries.
        const broken = join(f.binDir, 'broken')
        writeFileSync(
          broken,
          [
            '#!/bin/sh',
            `echo "$@" >> "${f.counterFile}"`,
            'if [ "$1" = "--version" ]; then echo 0.1.3; exit 0; fi',
            'exit 4',
            ''
          ].join('\n'),
          'utf-8'
        )
        chmodSync(broken, 0o755)
        process.env.IMPECCABLE_BIN = broken
        resetImpeccableRuntimeCache()

        const first = await ensureProvisioned()
        assert.equal(first.status, 'failed')
        assert.equal(installCount(f), 1)

        const second = await ensureProvisioned()
        assert.equal(second.status, 'failed')
        assert.equal(installCount(f), 1, 'cooldown must suppress the immediate retry')
        assert.equal(second.reason, first.reason, 'the cached failure is reported verbatim')

        // An explicit retry bypasses the cooldown — and now succeeds, because
        // the working engine is back.
        process.env.IMPECCABLE_BIN = join(f.binDir, 'engine')
        const forced = await ensureProvisioned({ force: true })
        assert.equal(forced.status, 'ready', `got ${forced.status}: ${forced.reason}`)
        assert.equal(installCount(f), 2, 'force must re-attempt the install')
      } finally {
        f.cleanup()
      }
    }))
})

// ── getProvisionState ────────────────────────────────────────────────────────

describe('getProvisionState', () => {
  test('reports not-provisioned before install and provisioned after', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        assert.equal(getProvisionState().provisioned, false)
        await ensureProvisioned()
        assert.equal(getProvisionState().provisioned, true)
        assert.equal(installCount(f), 1, 'state check must not trigger an install')
      } finally {
        f.cleanup()
      }
    }))
})

// ── markdown reads ───────────────────────────────────────────────────────────

describe('readSkillMarkdown / readCommandMarkdown', () => {
  test('returns null when nothing is provisioned', () => {
    const f = setup()
    try {
      assert.equal(readSkillMarkdown(), null)
      assert.equal(readCommandMarkdown('critique'), null)
    } finally {
      f.cleanup()
    }
  })

  test('reads SKILL.md and a per-command reference playbook', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        const skill = readSkillMarkdown()
        assert.ok(skill, 'expected SKILL.md')
        assert.ok(skill.content.includes('Impeccable SKILL'))

        const cmd = readCommandMarkdown('critique')
        assert.ok(cmd, 'expected reference/critique.md')
        assert.ok(cmd.content.includes('critique playbook'))
        assert.ok(cmd.path.endsWith(join('reference', 'critique.md')))
      } finally {
        f.cleanup()
      }
    }))

  test('returns null for a command with no playbook', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        assert.equal(readCommandMarkdown('no-such-command'), null)
      } finally {
        f.cleanup()
      }
    }))

  test('rejects path traversal in the command id', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        assert.equal(readCommandMarkdown('../../SKILL'), null)
        assert.equal(readCommandMarkdown('/etc/passwd'), null)
      } finally {
        f.cleanup()
      }
    }))

  test('mtime cache serves cached content but re-reads after a real change', () =>
    runExclusive(async () => {
      if (isWindows) return
      const f = setup()
      try {
        await ensureProvisioned()
        const path = join(getSkillDir(), 'SKILL.md')

        // Pin the mtime to a whole second. Re-applying the exact same Date then
        // yields the exact same mtimeMs, which a sub-millisecond timestamp would
        // not — that precision loss, not the cache, would otherwise fail this.
        const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000)
        utimesSync(path, pinned, pinned)

        const first = readSkillMarkdown()
        assert.ok(first)

        // Rewrite content but restore the same mtime: the cache should win.
        writeFileSync(path, '# CHANGED\n', 'utf-8')
        utimesSync(path, pinned, pinned)
        const cached = readSkillMarkdown()
        assert.equal(cached?.content, first.content, 'unchanged mtime must serve the cache')

        // Now bump the mtime — the read must refresh.
        const future = new Date(pinned.getTime() + 5_000)
        utimesSync(path, future, future)
        const refreshed = readSkillMarkdown()
        assert.equal(refreshed?.content, '# CHANGED\n', 'changed mtime must invalidate the cache')
      } finally {
        f.cleanup()
      }
    }))
})

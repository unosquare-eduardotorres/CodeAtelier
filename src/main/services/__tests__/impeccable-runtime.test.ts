/**
 * Unit tests for src/main/services/impeccable-runtime.service.ts
 *
 * Covers platform mapping (including the windows/win32 token trap), the
 * three-tier binary resolution order, executable checking, the never-throws
 * contract of runEngine, and availability probe caching.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, runExclusive } from './test-harness'
import {
  IMPECCABLE_ENGINE_VERSION,
  __setAppRootForTests,
  checkAvailability,
  resetImpeccableRuntimeCache,
  resolveEngineBinary,
  resolvePlatformTarget,
  runEngine
} from '../impeccable-runtime.service'

const isWindows = process.platform === 'win32'

/** Creates a throwaway dir; caller removes it. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'impeccable-runtime-'))
}

/** Writes a shell script that prints `output` and exits `code`. */
function writeFakeEngine(path: string, output: string, code = 0): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "${output}"\nexit ${code}\n`, 'utf-8')
  chmodSync(path, 0o755)
}

// ── resolvePlatformTarget ────────────────────────────────────────────────────

describe('resolvePlatformTarget', () => {
  test('maps win32 to the "windows" package token, not "win32"', () => {
    const r = resolvePlatformTarget('win32', 'x64')
    assert.ok(r)
    assert.equal(r.packageName, '@impeccable/cli-windows-x64')
    assert.equal(r.exeName, 'impeccable.exe')
  })

  test('maps darwin/arm64 to the published package name', () => {
    const r = resolvePlatformTarget('darwin', 'arm64')
    assert.ok(r)
    assert.equal(r.packageName, '@impeccable/cli-darwin-arm64')
    assert.equal(r.exeName, 'impeccable')
  })

  test('maps linux/x64', () => {
    const r = resolvePlatformTarget('linux', 'x64')
    assert.ok(r)
    assert.equal(r.packageName, '@impeccable/cli-linux-x64')
  })

  test('returns null for an unsupported platform', () => {
    assert.equal(resolvePlatformTarget('aix' as NodeJS.Platform, 'x64'), null)
  })

  test('returns null for an unsupported architecture', () => {
    assert.equal(resolvePlatformTarget('darwin', 'ppc64'), null)
  })
})

// ── resolveEngineBinary ──────────────────────────────────────────────────────

describe('resolveEngineBinary', () => {
  test('honors the IMPECCABLE_BIN override ahead of everything else', () => {
    if (isWindows) return
    const dir = scratch()
    const prevBin = process.env.IMPECCABLE_BIN
    try {
      const fake = join(dir, 'my-engine')
      writeFakeEngine(fake, '0.1.3')
      process.env.IMPECCABLE_BIN = fake
      resetImpeccableRuntimeCache()
      assert.equal(resolveEngineBinary(), fake)
    } finally {
      if (prevBin === undefined) delete process.env.IMPECCABLE_BIN
      else process.env.IMPECCABLE_BIN = prevBin
      resetImpeccableRuntimeCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ignores a non-executable override and falls through', () => {
    if (isWindows) return
    const dir = scratch()
    const prevBin = process.env.IMPECCABLE_BIN
    try {
      const notExec = join(dir, 'not-executable')
      writeFileSync(notExec, 'nope', 'utf-8')
      chmodSync(notExec, 0o644)
      process.env.IMPECCABLE_BIN = notExec
      resetImpeccableRuntimeCache()
      assert.notEqual(
        resolveEngineBinary(),
        notExec,
        'a non-executable file must not be accepted as the engine'
      )
    } finally {
      if (prevBin === undefined) delete process.env.IMPECCABLE_BIN
      else process.env.IMPECCABLE_BIN = prevBin
      resetImpeccableRuntimeCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('finds the version-partitioned launcher cache via IMPECCABLE_HOME', () => {
    if (isWindows) return
    const dir = scratch()
    const prevBin = process.env.IMPECCABLE_BIN
    const prevHome = process.env.IMPECCABLE_HOME
    try {
      delete process.env.IMPECCABLE_BIN
      process.env.IMPECCABLE_HOME = dir
      // Point the bundled-dependency tier at an empty root so it misses and
      // tier 2 is exercised. Uses the seam rather than process.chdir(), which
      // would corrupt suites that resolve paths against cwd.
      __setAppRootForTests(dir)
      // Upstream partitions the cache by engine version — assert we look in the
      // versioned subdir, not a flat bin/.
      const cached = join(dir, 'bin', IMPECCABLE_ENGINE_VERSION, 'impeccable')
      mkdirSync(join(dir, 'bin', IMPECCABLE_ENGINE_VERSION), { recursive: true })
      writeFakeEngine(cached, '0.1.3')
      resetImpeccableRuntimeCache()
      assert.equal(resolveEngineBinary(), cached)
    } finally {
      __setAppRootForTests(null)
      if (prevBin !== undefined) process.env.IMPECCABLE_BIN = prevBin
      if (prevHome === undefined) delete process.env.IMPECCABLE_HOME
      else process.env.IMPECCABLE_HOME = prevHome
      resetImpeccableRuntimeCache()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('memoises the resolved path across calls', () => {
    resetImpeccableRuntimeCache()
    const first = resolveEngineBinary()
    assert.equal(resolveEngineBinary(), first)
  })

  test('resolves the real bundled optional dependency in this repo', () => {
    // Guards the packaging story: if the optional dep stops installing, this
    // fails here rather than in a DMG.
    const prevBin = process.env.IMPECCABLE_BIN
    const prevHome = process.env.IMPECCABLE_HOME
    try {
      delete process.env.IMPECCABLE_BIN
      delete process.env.IMPECCABLE_HOME
      resetImpeccableRuntimeCache()
      const resolved = resolveEngineBinary()
      assert.ok(resolved, 'expected a resolution result')
      assert.ok(
        resolved.includes('@impeccable'),
        `expected the bundled engine, got ${resolved} — is the optional dependency installed?`
      )
    } finally {
      if (prevBin !== undefined) process.env.IMPECCABLE_BIN = prevBin
      if (prevHome !== undefined) process.env.IMPECCABLE_HOME = prevHome
      resetImpeccableRuntimeCache()
    }
  })
})

// ── runEngine ────────────────────────────────────────────────────────────────

describe('runEngine', () => {
  test('returns stdout and code 0 for a successful run', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, 'hello-engine')
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const res = await runEngine([])
        assert.equal(res.code, 0)
        assert.equal(res.stdout.trim(), 'hello-engine')
        assert.equal(res.timedOut, false)
        assert.equal(res.error, undefined)
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('reports a non-zero exit as a code, not an error (detector uses exit 2)', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, 'findings', 2)
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const res = await runEngine([])
        assert.equal(res.code, 2)
        assert.equal(res.error, undefined, 'exit 2 must not be surfaced as a spawn error')
        assert.equal(res.stdout.trim(), 'findings')
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('kills on timeout and reports timedOut instead of throwing', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFileSync(fake, '#!/bin/sh\nsleep 5\n', 'utf-8')
        chmodSync(fake, 0o755)
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const res = await runEngine([], { timeoutMs: 300 })
        assert.equal(res.timedOut, true, 'expected the timeout kill to be reported')
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('resolves rather than rejecting when the configured binary is missing', () =>
    runExclusive(async () => {
      // A bogus IMPECCABLE_BIN must not be fatal: resolution falls through to
      // the bundled optional dependency, and runEngine still settles with a
      // well-formed result object rather than throwing.
      const prev = process.env.IMPECCABLE_BIN
      try {
        process.env.IMPECCABLE_BIN = join(tmpdir(), 'definitely-not-here-impeccable')
        resetImpeccableRuntimeCache()
        const res = await runEngine(['--version'], { timeoutMs: 5_000 })
        assert.equal(typeof res, 'object')
        assert.equal(res.timedOut, false)
        assert.ok(
          'code' in res && 'stdout' in res && 'stderr' in res,
          'result must always carry the full shape'
        )
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
      }
    }))
})

// ── checkAvailability ────────────────────────────────────────────────────────

describe('checkAvailability', () => {
  test('reports available with a parsed version', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, '0.1.3')
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const res = await checkAvailability()
        assert.equal(res.available, true)
        assert.equal(res.version, '0.1.3')
        assert.equal(res.path, fake)
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('memoises the result — a later binary change is not re-probed', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, '0.1.3')
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const first = await checkAvailability()
        rmSync(fake, { force: true })
        const second = await checkAvailability()
        assert.deepEqual(second, first, 'availability must be cached for the session')
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('concurrent callers share a single in-flight probe', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, '0.1.3')
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const [a, b] = await Promise.all([checkAvailability(), checkAvailability()])
        assert.deepEqual(a, b)
        assert.equal(a.available, true)
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test('a failing probe degrades to available:false with a reason, never throws', () =>
    runExclusive(async () => {
      if (isWindows) return
      const dir = scratch()
      const prev = process.env.IMPECCABLE_BIN
      try {
        const fake = join(dir, 'engine')
        writeFakeEngine(fake, 'boom', 3)
        process.env.IMPECCABLE_BIN = fake
        resetImpeccableRuntimeCache()
        const res = await checkAvailability()
        assert.equal(res.available, false)
        assert.ok(res.reason && res.reason.length > 0, 'expected a diagnostic reason')
      } finally {
        if (prev === undefined) delete process.env.IMPECCABLE_BIN
        else process.env.IMPECCABLE_BIN = prev
        resetImpeccableRuntimeCache()
        rmSync(dir, { recursive: true, force: true })
      }
    }))
})

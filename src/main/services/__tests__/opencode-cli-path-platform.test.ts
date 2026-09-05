/**
 * Platform-matrix tests for OpenCode CLI path resolution.
 *
 * The Windows defects these cover (wrong lookup tool, `<prefix>/bin/opencode`
 * shape, ':' PATH delimiter, HOME instead of USERPROFILE) were all invisible on
 * macOS because the existing suite only ever exercised the host platform.
 *
 * Everything here is PURE — platform and environment are parameters, so Windows
 * behaviour is asserted from any host. Tests that need a real binary live in
 * opencode-path-augmentation.test.ts and stay platform-guarded.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  opencodeCandidates,
  prependToPath,
  wellKnownCliDirs,
  homeDirFor,
  pickExecutableFromLookup,
  resolveOpencodePath,
  getOpencodePath
} from '../../../shared/opencode-cli-path'

const WIN_ENV = {
  USERPROFILE: 'C:\\Users\\dev',
  APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'
}

const POSIX_ENV = { HOME: '/Users/dev' }

describe('homeDirFor', () => {
  test('win32 uses USERPROFILE, not HOME', () => {
    assert.equal(homeDirFor('win32', WIN_ENV), 'C:\\Users\\dev')
  })

  test('win32 never yields a relative path when HOME is unset', () => {
    // The original bug: HOME is undefined on Windows, so join('', 'AppData', ...)
    // produced the *relative* string 'AppData\\Roaming\\npm'.
    const dirs = wellKnownCliDirs('win32', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' })
    for (const dir of dirs) {
      assert.ok(/^[A-Za-z]:\\/.test(dir), `expected absolute Windows path, got: ${dir}`)
    }
  })

  test('posix uses HOME', () => {
    assert.equal(homeDirFor('darwin', POSIX_ENV), '/Users/dev')
  })
})

describe('opencodeCandidates — win32', () => {
  const candidates = opencodeCandidates({
    platform: 'win32',
    env: WIN_ENV,
    npmPrefix: 'C:\\Users\\dev\\AppData\\Roaming\\npm'
  })

  test('puts the .cmd shim in the prefix ROOT, not a bin/ subdirectory', () => {
    assert.ok(
      candidates.includes('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd'),
      `missing prefix-root .cmd shim in: ${candidates.join(', ')}`
    )
  })

  test('never probes <prefix>/bin/opencode — that shape does not exist on Windows', () => {
    assert.ok(
      !candidates.some((c) => /[\\/]bin[\\/]/.test(c)),
      `should not contain a bin/ segment: ${candidates.join(', ')}`
    )
  })

  test('prefers .cmd over the extensionless shell script', () => {
    const cmdIndex = candidates.indexOf('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd')
    const bareIndex = candidates.indexOf('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode')
    assert.ok(cmdIndex >= 0 && bareIndex >= 0)
    assert.ok(cmdIndex < bareIndex, '.cmd must be probed before the extensionless script')
  })

  test('uses Windows separators even when built on a POSIX host', () => {
    assert.ok(
      candidates.every((c) => !c.includes('/')),
      `candidates must not contain forward slashes: ${candidates.join(', ')}`
    )
  })

  test('falls back to well-known locations when npm is unreachable', () => {
    // The packaged app inherits a PATH without node/npm, so `npm config get
    // prefix` cannot run — resolution must still have somewhere to look.
    const noPrefix = opencodeCandidates({ platform: 'win32', env: WIN_ENV, npmPrefix: null })

    assert.ok(noPrefix.includes('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.cmd'))
    assert.ok(noPrefix.includes('C:\\Users\\dev\\AppData\\Local\\npm\\opencode.cmd'))
    assert.ok(noPrefix.includes('C:\\Program Files\\nodejs\\opencode.cmd'))
  })

  test('deduplicates case-insensitively', () => {
    const lowered = candidates.map((c) => c.toLowerCase())
    assert.equal(new Set(lowered).size, lowered.length, 'duplicate candidates on win32')
  })
})

describe('opencodeCandidates — posix', () => {
  test('darwin uses <prefix>/bin/opencode', () => {
    const candidates = opencodeCandidates({
      platform: 'darwin',
      env: POSIX_ENV,
      npmPrefix: '/opt/homebrew'
    })

    assert.ok(candidates.includes('/opt/homebrew/bin/opencode'))
    assert.ok(candidates.includes('/usr/local/bin/opencode'))
    assert.ok(candidates.includes('/Users/dev/.npm-global/bin/opencode'))
  })

  test('darwin probes only the bare name (no .cmd/.exe)', () => {
    const candidates = opencodeCandidates({ platform: 'darwin', env: POSIX_ENV })
    assert.ok(candidates.every((c) => c.endsWith('/opencode')))
  })

  test('linux includes snap and ~/.local/bin', () => {
    const candidates = opencodeCandidates({ platform: 'linux', env: POSIX_ENV })
    assert.ok(candidates.includes('/snap/bin/opencode'))
    assert.ok(candidates.includes('/Users/dev/.local/bin/opencode'))
  })
})

describe('prependToPath', () => {
  test('win32: the first existing entry survives intact', () => {
    // Regression for the exact corruption: hardcoding ':' fused the new entry
    // and the first existing entry into one invalid path.
    const existing = 'C:\\Windows\\System32;C:\\Windows'
    const result = prependToPath(existing, 'C:\\Users\\dev\\AppData\\Roaming\\npm', ';')

    const entries = result.split(';')
    assert.equal(entries[0], 'C:\\Users\\dev\\AppData\\Roaming\\npm')
    assert.equal(entries[1], 'C:\\Windows\\System32')
    assert.ok(!result.includes(':C:\\Windows\\System32'), 'must not fuse entries with a colon')
  })

  test('posix: joins with ":"', () => {
    const result = prependToPath('/usr/bin:/bin', '/opt/homebrew/bin', ':')
    assert.equal(result, '/opt/homebrew/bin:/usr/bin:/bin')
  })

  test('is idempotent', () => {
    const once = prependToPath('/usr/bin:/bin', '/opt/homebrew/bin', ':')
    const twice = prependToPath(once, '/opt/homebrew/bin', ':')
    assert.equal(twice, once)
  })

  test('win32 dedupe is case-insensitive and ignores trailing separators', () => {
    const existing = 'C:\\Program Files\\nodejs\\;C:\\Windows'
    const result = prependToPath(existing, 'c:\\program files\\nodejs', ';')
    assert.equal(result, existing, 'should recognise the entry despite case and trailing slash')
  })

  test('handles an empty starting PATH', () => {
    assert.equal(prependToPath('', '/opt/homebrew/bin', ':'), '/opt/homebrew/bin')
  })

  test('ignores an empty directory', () => {
    assert.equal(prependToPath('/usr/bin', '', ':'), '/usr/bin')
  })
})

describe('pickExecutableFromLookup', () => {
  test('win32: prefers the .cmd line over the extensionless one', () => {
    // `where opencode` commonly lists the shell script first.
    const stdout = 'C:\\npm\\opencode\r\nC:\\npm\\opencode.cmd\r\nC:\\npm\\opencode.ps1\r\n'
    assert.equal(pickExecutableFromLookup(stdout, 'win32'), 'C:\\npm\\opencode.cmd')
  })

  test('win32: falls back to the first line when no known extension is present', () => {
    assert.equal(pickExecutableFromLookup('C:\\npm\\opencode\r\n', 'win32'), 'C:\\npm\\opencode')
  })

  test('posix: takes the first line', () => {
    assert.equal(
      pickExecutableFromLookup('/opt/homebrew/bin/opencode\n/usr/local/bin/opencode\n', 'darwin'),
      '/opt/homebrew/bin/opencode'
    )
  })

  test('returns null for empty output', () => {
    assert.equal(pickExecutableFromLookup('', 'win32'), null)
    assert.equal(pickExecutableFromLookup('  \n \n', 'darwin'), null)
  })
})

describe('resolver failure is not permanent', () => {
  test('a failed resolution is not cached as a permanent null', () => {
    // The consumer-side bug: checkCliAvailable read the cache only, so one
    // failed startup resolution made every subsequent task fail instantly.
    const first = resolveOpencodePath()

    if (first === null) {
      assert.equal(getOpencodePath(), null, 'nothing should be cached after a failure')
      // Re-probing must be permitted rather than short-circuited.
      assert.equal(resolveOpencodePath(), null)
    } else {
      assert.equal(getOpencodePath(), first, 'success must be cached')
    }
  })

  test('force re-resolves without breaking the cached happy path', () => {
    const resolved = resolveOpencodePath()
    const forced = resolveOpencodePath({ force: true })
    assert.equal(forced, resolved)
  })
})

describe('checkCliAvailable failure message', () => {
  test('reports what was probed instead of assuming the CLI is missing', async () => {
    const { OpenCodeExecutor } = await import('../opencode-executor')
    const message = await new OpenCodeExecutor().checkCliAvailable()

    if (message === null) return // CLI installed and runnable — nothing to assert

    if (message.includes('could not be located')) {
      // The old message was a static "install it" string produced WITHOUT
      // probing. These markers can only come from a real resolution attempt.
      assert.ok(message.includes('Probed paths:'), `expected probe report, got: ${message}`)
      assert.ok(message.includes('PATH in effect:'), `expected effective PATH, got: ${message}`)
    } else {
      // Found but not runnable — must name the binary it actually tried.
      assert.ok(
        message.includes('opencode'),
        `expected the resolved path in the message, got: ${message}`
      )
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

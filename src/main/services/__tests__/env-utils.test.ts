/**
 * Unit tests for env-utils.ts — buildEnvWithPath sanitizes nested-session env
 * vars and prepends bin directories in priority order using path.delimiter.
 *
 * process.env is mutated and restored in try/finally so the suite is hermetic.
 */
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { buildEnvWithPath } from '../env-utils'

/** Snapshot + restore process.env around a mutation. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  const keys = new Set([
    ...Object.keys(patch),
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'PATH',
    'HOME',
    'USERPROFILE',
    'NODE_ENV',
    'CLAUDE_SHIM_DIR'
  ])
  for (const k of keys) saved[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe('env-utils › buildEnvWithPath', () => {
  test('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT', () => {
    withEnv(
      {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined
      },
      () => {
        const env = buildEnvWithPath()
        assert.equal(env.CLAUDECODE, undefined)
        assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
      }
    )
  })

  test('prepends bin dirs in priority order: /usr/local/bin, /opt/homebrew/bin, ~/.local/bin', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/me', USERPROFILE: undefined }, () => {
      const env = buildEnvWithPath()
      const parts = (env.PATH ?? '').split(delimiter)
      assert.deepEqual(parts.slice(0, 4), [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/home/me/.local/bin',
        '/usr/bin'
      ])
    })
  })

  test('uses path.delimiter between segments', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/me', USERPROFILE: undefined }, () => {
      const env = buildEnvWithPath()
      assert.ok((env.PATH ?? '').includes(`/usr/local/bin${delimiter}`))
    })
  })

  test('falls back to USERPROFILE when HOME is absent', () => {
    withEnv({ PATH: '/usr/bin', HOME: undefined, USERPROFILE: '/Users/me' }, () => {
      const env = buildEnvWithPath()
      assert.ok((env.PATH ?? '').includes(`/Users/me/.local/bin${delimiter}`))
    })
  })

  test('skips ~/.local/bin prepend when no home dir is available', () => {
    withEnv({ PATH: '/usr/bin', HOME: undefined, USERPROFILE: undefined }, () => {
      const env = buildEnvWithPath()
      assert.ok(!(env.PATH ?? '').includes('/.local/bin'))
      // The homebrew/usr-local prepends still apply because PATH exists.
      const parts = (env.PATH ?? '').split(delimiter)
      assert.deepEqual(parts.slice(0, 2), ['/usr/local/bin', '/opt/homebrew/bin'])
    })
  })

  // The E2E shim seam. Without it, /usr/local/bin lands ahead of the fixture's
  // shim dir and every "shim-gated" test silently runs the real claude CLI.
  test('test builds let the E2E claude shim win over a real install', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_ENV: 'test',
        CLAUDE_SHIM_DIR: '/repo/e2e/helpers/claude-shim'
      },
      () => {
        const parts = (buildEnvWithPath().PATH ?? '').split(delimiter)
        assert.equal(parts[0], '/repo/e2e/helpers/claude-shim')
      }
    )
  })

  test('the shim seam is inert outside test builds', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_ENV: 'production',
        CLAUDE_SHIM_DIR: '/repo/e2e/helpers/claude-shim'
      },
      () => {
        const path = buildEnvWithPath().PATH ?? ''
        assert.ok(!path.includes('claude-shim'), 'a stray env var must not redirect the CLI')
        assert.equal(path.split(delimiter)[0], '/usr/local/bin')
      }
    )
  })

  test('no-PATH edge: leaves PATH undefined and prepends nothing', () => {
    withEnv({ PATH: undefined, HOME: '/home/me', USERPROFILE: undefined }, () => {
      const env = buildEnvWithPath()
      assert.equal(env.PATH, undefined)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

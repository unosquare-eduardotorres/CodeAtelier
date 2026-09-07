/**
 * Unit tests for env-utils.ts — buildEnvWithPath sanitizes nested-session env
 * vars and prepends bin directories in priority order using path.delimiter.
 *
 * process.env is mutated and restored in try/finally so the suite is hermetic.
 */
import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { buildEnvWithPath, buildGateEnv } from '../env-utils'

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
    'NODE_OPTIONS',
    'CI',
    'FORCE_COLOR',
    'npm_config_production',
    'npm_lifecycle_event',
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

describe('env-utils › buildGateEnv', () => {
  // The W16 incident: NODE_ENV=production in the launching shell made `npm ci`
  // skip devDependencies in the TARGET repo, so its test runner was absent and
  // three suites reported bogus reds ("No such built-in module: node:").
  test('deletes NODE_ENV=production from the parent environment', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_ENV: 'production'
      },
      () => {
        const env = buildGateEnv()
        assert.equal('NODE_ENV' in env, false)
        assert.equal(env.NODE_ENV, undefined)
      }
    )
  })

  test('deletes npm_* lifecycle/config leakage from a `npm run dev` launch', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_ENV: 'development',
        npm_config_production: 'true',
        npm_lifecycle_event: 'dev',
        npm_config_user_agent: 'npm/10.0.0 node/v22.0.0'
      },
      () => {
        const env = buildGateEnv()
        assert.equal('npm_config_production' in env, false)
        assert.equal('npm_lifecycle_event' in env, false)
        assert.equal('npm_config_user_agent' in env, false)
        const npmKeys = Object.keys(env).filter((k) => k.startsWith('npm_'))
        assert.deepEqual(npmKeys, [])
      }
    )
  })

  test('deletes NODE_OPTIONS and vitest worker identity', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_OPTIONS: '--import tsx',
        VITEST: 'true',
        VITEST_POOL_ID: '3',
        VITEST_WORKER_ID: '7'
      },
      () => {
        const env = buildGateEnv()
        assert.equal('NODE_OPTIONS' in env, false)
        assert.equal('VITEST' in env, false)
        assert.equal('VITEST_POOL_ID' in env, false)
        assert.equal('VITEST_WORKER_ID' in env, false)
      }
    )
  })

  test('sets CI=true and FORCE_COLOR=0 (deterministic output)', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/me', USERPROFILE: undefined }, () => {
      const env = buildGateEnv()
      assert.equal(env.CI, 'true')
      assert.equal(env.FORCE_COLOR, '0')
    })
  })

  // Regression guard vs buildEnvWithPath: a packaged app launched from Finder
  // has a minimal PATH, and without the prepends npm-based gates report
  // command_missing → environmentalFailure.
  test('keeps the three PATH prepends (no regression vs buildEnvWithPath)', () => {
    withEnv({ PATH: '/usr/bin', HOME: '/home/me', USERPROFILE: undefined }, () => {
      const parts = (buildGateEnv().PATH ?? '').split(delimiter)
      assert.deepEqual(parts.slice(0, 4), [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/home/me/.local/bin',
        '/usr/bin'
      ])
    })
  })

  test('parent process.env is not mutated', () => {
    withEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        USERPROFILE: undefined,
        NODE_ENV: 'production',
        npm_config_production: 'true',
        // Explicitly cleared: the assertion below would otherwise depend on
        // whether THIS test run happens to execute under a CI runner.
        CI: undefined,
        FORCE_COLOR: undefined
      },
      () => {
        buildGateEnv()
        assert.equal(process.env.NODE_ENV, 'production')
        assert.equal(process.env.npm_config_production, 'true')
        assert.equal(process.env.CI, undefined)
        assert.equal(process.env.FORCE_COLOR, undefined)
        // PATH untouched — the prepend lives only in the returned copy.
        assert.equal((process.env.PATH ?? '').split(delimiter)[0], '/usr/bin')
      }
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

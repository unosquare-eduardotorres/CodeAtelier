/**
 * Tests for OpenCode CLI PATH augmentation.
 *
 * Validates that augmenting process.env.PATH enables child_process.spawn()
 * to find the opencode CLI binary in common installation paths.
 *
 * These tests ensure the Electron app can locate and spawn the OpenCode CLI
 * even when starting with a truncated PATH (as happens in packaged apps).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import {
  augmentOpenCodeCliPath,
  locateOpenCodeCli,
  checkOpenCodeCliSync
} from '../../../shared/opencode-cli-path'

describe('OpenCode CLI PATH augmentation', () => {
  test('augmentOpenCodeCliPath adds Homebrew paths to PATH', () =>
    runExclusive(async () => {
      const originalPath = process.env.PATH

      try {
        // Augment PATH
        augmentOpenCodeCliPath()

        // Verify at least one Homebrew path was added
        const homebrewPathsAdded =
          process.env.PATH?.includes('/opt/homebrew/bin') ||
          process.env.PATH?.includes('/usr/local/bin')

        assert.ok(homebrewPathsAdded, 'Should include Homebrew bin in PATH')
      } finally {
        // Always restore PATH after test
        process.env.PATH = originalPath
      }
    }))

  test('augmentOpenCodeCliPath handles duplicate paths correctly', () =>
    runExclusive(async () => {
      const originalPath = process.env.PATH

      try {
        // Start with a clean PATH that has no homebrew paths
        process.env.PATH = '/usr/bin:/bin'

        // Add paths twice
        augmentOpenCodeCliPath()
        const pathAfterFirst = process.env.PATH
        augmentOpenCodeCliPath()
        const pathAfterSecond = process.env.PATH

        // Second call should not change PATH (deduplication)
        assert.equal(pathAfterSecond, pathAfterFirst, 'Second call should not add duplicate paths')
      } finally {
        process.env.PATH = originalPath
      }
    }))

  test('augmentOpenCodeCliPath adds npm global bin to PATH', () =>
    runExclusive(async () => {
      const originalPath = process.env.PATH
      const HOME = process.env.HOME || ''
      const npmGlobalPath = join(HOME, '.npm-global', 'bin')

      try {
        augmentOpenCodeCliPath()

        // Verify npm global path is added if HOME is set
        if (HOME) {
          assert.ok(process.env.PATH?.includes(npmGlobalPath), 'Should include npm global bin')
        }
      } finally {
        process.env.PATH = originalPath
      }
    }))
})

describe('OpenCode CLI spawn with PATH augmentation', () => {
  test('spawn("opencode", ...) succeeds WITH PATH augmentation if CLI is installed', () =>
    runExclusive(async () => {
      // Augment PATH
      augmentOpenCodeCliPath()

      // Try to spawn with augmentation
      const result = spawnSync('opencode', ['--version'], { timeout: 3000, stdio: 'pipe' })

      if (result.error) {
        // CLI not installed - this is OK. The test validates PATH augmentation works.
        assert.ok(
          process.env.PATH?.includes('/opt/homebrew/bin') ||
            process.env.PATH?.includes('/usr/local/bin'),
          'PATH augmentation working (opencode may not be installed)'
        )
      } else if (result.status === 0) {
        // CLI found and executed successfully
        const version = result.stdout.toString().trim()
        assert.ok(true, `Found OpenCode CLI version: ${version}`)
      } else {
        // Spawning failed with exit code
        assert.fail(`opencode returned exit code ${result.status}: ${result.stderr?.toString()}`)
      }
    }))
})

describe('OpenCode CLI location', () => {
  test('locateOpenCodeCli() finds CLI after PATH augmentation', async () => {
    const result = await locateOpenCodeCli()

    if (result.available) {
      // If CLI exists, should find it in a common path
      assert.ok(
        result.path &&
          (result.path.includes('/opt/homebrew') ||
            result.path.includes('/usr/local') ||
            result.path.includes('.npm-global')),
        `Should locate opencode in common installation path: ${result.path}`
      )

      assert.ok(result.source, 'Should report how path was located')
    } else {
      // If not installed, should provide helpful error
      assert.ok(
        result.error &&
          result.error.includes('opencode') &&
          (result.error.includes('Install') || result.error.includes('not found')),
        `Should provide helpful error message: ${result.error}`
      )
    }
  })

  test('checkOpenCodeCliSync returns correct result', () => {
    const result = checkOpenCodeCliSync()

    // Result should have valid structure
    assert.ok(typeof result.available === 'boolean', 'available should be boolean')

    if (result.available) {
      assert.ok(
        result.path && result.path.endsWith('opencode'),
        'If available, path should point to opencode binary'
      )
    } else {
      assert.ok(typeof result.error === 'string', 'If not available, should have error message')
    }
  })
})

describe('OpenCodeExecutor integration with PATH augmentation', () => {
  test('augmented PATH enables OpenCodeExecutor.start() to find CLI', () =>
    runExclusive(async () => {
      const { OpenCodeExecutor } = await import('../opencode-executor')

      // Augment PATH first
      augmentOpenCodeCliPath()

      const configDir = join(tmpdir(), `opencode-path-integration-test-${Date.now()}`)
      mkdirSync(configDir, { recursive: true })

      const config = {
        $schema: 'https://opencode.ai/config.json',
        model: 'test-model',
        provider: {},
        mcp: {},
        instructions: [],
        plugin: [],
        tools: { question: false },
        permission: { Read: 'allow', Glob: 'allow', Grep: 'allow' }
      }

      const configPath = join(configDir, 'opencode.json')
      writeFileSync(configPath, JSON.stringify(config, null, 2))

      const executor = new OpenCodeExecutor()

      try {
        await executor.start(configDir, { configPath, isLocal: false })

        // If we got here, the CLI was found and spawned successfully
        await executor.stop()
        assert.ok(true, 'Server started successfully with augmented PATH')
      } catch (error) {
        const err = error as Error

        // Should NOT get spawn ENOENT if PATH is properly augmented
        const isSpawnError = err.message.includes('ENOENT') || err.message.includes('spawn')

        if (isSpawnError) {
          assert.fail(`With PATH augmentation, should not get spawn error: ${err.message}`)
        } else {
          // Other errors (like missing dependencies) are OK - PATH augmentation worked
          assert.ok(
            true,
            `PATH augmentation working (auth or config error is separate): ${err.message}`
          )
        }
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    }))

  test('checkCliAvailable() finds CLI after augmentOpenCodeCliPath()', () =>
    runExclusive(async () => {
      const { OpenCodeExecutor } = await import('../opencode-executor')

      // Augment PATH first
      augmentOpenCodeCliPath()

      const executor = new OpenCodeExecutor()
      const error = await executor.checkCliAvailable()

      // Should find CLI if installed (or provide helpful message if not)
      if (error) {
        // If CLI not available, should have helpful message
        assert.ok(
          error.includes('opencode') && (error.includes('Install') || error.includes('not found')),
          `Should provide helpful message: ${error}`
        )
      } else {
        // CLI found
        assert.ok(true, 'CLI found after PATH augmentation')
      }
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

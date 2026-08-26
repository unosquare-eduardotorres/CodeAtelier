/**
 * LocalEmbeddingProvider facade unit tests.
 *
 * Validates that the facade correctly:
 *   - Routes to oMLX by default
 *   - Switches backends via setBackend()
 *   - Exposes the same interface as omlxEmbeddingProvider (isReady, activeModelName, etc.)
 *   - Handles Ollama-specific configuration (model name, base URL)
 *   - Emits modelError when Ollama is misconfigured (no model selected)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { localEmbeddingProvider } from '../local-embedding.provider'
import { workspaceRepository } from '../../db/repositories'
import { defaultLocalLlmBackend } from '../../../shared/constants'

/**
 * `localEmbeddingProvider` is a process-wide singleton. When an earlier test
 * file in the shared run calls `registerEmbeddingIpc(mainWindow)`, that adds
 * permanent modelReady/modelError listeners which call
 * `mainWindow.webContents.send(...)`. With a stub window that has no
 * `webContents`, those listeners throw synchronously out of `emit()` and fail
 * whichever test emitted. Drop them so each test controls its own listeners.
 */
function dropLeakedListeners(): void {
  localEmbeddingProvider.removeAllListeners('modelReady')
  localEmbeddingProvider.removeAllListeners('modelError')
}

describe('LocalEmbeddingProvider — interface contract', () => {
  test('exports singleton instance', () => {
    assert.ok(localEmbeddingProvider, 'localEmbeddingProvider should be exported')
    assert.equal(typeof localEmbeddingProvider.embed, 'function', 'embed() method')
    assert.equal(typeof localEmbeddingProvider.initialize, 'function', 'initialize() method')
    assert.equal(typeof localEmbeddingProvider.dispose, 'function', 'dispose() method')
    assert.equal(typeof localEmbeddingProvider.reinitialize, 'function', 'reinitialize() method')
    assert.equal(
      typeof localEmbeddingProvider.ensureEmbeddingReady,
      'function',
      'ensureEmbeddingReady() method'
    )
  })

  test('has isReady getter', () => {
    assert.equal(typeof localEmbeddingProvider.isReady, 'boolean')
  })

  test('has activeModelName getter', () => {
    assert.equal(typeof localEmbeddingProvider.activeModelName, 'string')
  })

  test('is an EventEmitter (modelReady/modelError events)', () => {
    assert.equal(typeof localEmbeddingProvider.on, 'function')
    assert.equal(typeof localEmbeddingProvider.emit, 'function')
    assert.equal(typeof localEmbeddingProvider.removeListener, 'function')
  })
})

describe('LocalEmbeddingProvider — backend switching', () => {
  test('setBackend accepts omlx and ollama', () => {
    // Should not throw
    localEmbeddingProvider.setBackend('omlx')
    localEmbeddingProvider.setBackend('ollama')
    // Reset to default
    localEmbeddingProvider.setBackend('omlx')
  })

  test('setOllamaEmbeddingModel stores model name', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    // After switching to ollama, activeModelName should reflect the set model
    assert.equal(localEmbeddingProvider.activeModelName, 'bge-m3')
    // Cleanup
    localEmbeddingProvider.setBackend('omlx')
  })

  test('setOllamaBaseUrl accepts custom URL', () => {
    // Should not throw
    localEmbeddingProvider.setOllamaBaseUrl('http://192.168.1.100:11434')
    localEmbeddingProvider.setOllamaBaseUrl('') // resets to default
  })

  test('activeBackend getter reflects the selected backend', () => {
    localEmbeddingProvider.setBackend('ollama')
    assert.equal(localEmbeddingProvider.activeBackend, 'ollama')
    localEmbeddingProvider.setBackend('omlx')
    assert.equal(localEmbeddingProvider.activeBackend, 'omlx')
  })

  /**
   * Regression: `setOllamaEmbeddingModel` used to ignore empty input, so a user
   * deselecting the model in the UI could never clear the running facade — it
   * kept embedding with the previous model forever.
   */
  test('setOllamaEmbeddingModel applies an empty value (clears the selection)', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    assert.equal(localEmbeddingProvider.activeModelName, 'bge-m3')

    localEmbeddingProvider.setOllamaEmbeddingModel('')
    assert.equal(localEmbeddingProvider.activeModelName, '', 'empty value must propagate')

    localEmbeddingProvider.setBackend('omlx')
  })

  /**
   * Regression: a backend switch left `_ollamaReady` stale, so an
   * omlx → ollama round-trip could short-circuit `_initOllama()` and skip
   * re-verifying that the model is still present.
   */
  test('setBackend resets the Ollama ready flag', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    // Simulate a previously-successful probe (the flag is private and only
    // reachable through a live Ollama server).
    ;(localEmbeddingProvider as any)._ollamaReady = true
    assert.equal(localEmbeddingProvider.isReady, true, 'precondition: ready')

    localEmbeddingProvider.setBackend('omlx')
    localEmbeddingProvider.setBackend('ollama')

    assert.equal(localEmbeddingProvider.isReady, false, 'ready flag must not survive a switch')

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })
})

describe('defaultLocalLlmBackend — platform fallback', () => {
  test('Apple Silicon defaults to omlx', () => {
    assert.equal(defaultLocalLlmBackend(true), 'omlx')
  })

  /** oMLX cannot run off Apple Silicon — defaulting to it there makes
   *  embeddings unreachable on Windows/Linux no matter what the user picks. */
  test('everything else defaults to ollama', () => {
    assert.equal(defaultLocalLlmBackend(false), 'ollama')
  })
})

describe('LocalEmbeddingProvider — Ollama error handling', () => {
  test('initialize with ollama backend and no model emits modelError', async () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.dispose() // clear any previous model
    dropLeakedListeners()

    const errors: string[] = []
    const handler = (e: string): void => {
      errors.push(e)
    }
    localEmbeddingProvider.on('modelError', handler)

    try {
      await localEmbeddingProvider.initialize()
      assert.fail('Should have thrown when no model configured')
    } catch (err) {
      assert.ok(err instanceof Error)
      assert.ok(
        err.message.includes('No Ollama embedding model'),
        `Error should mention model: ${err.message}`
      )
    }

    assert.ok(errors.length > 0, 'Should have emitted modelError')
    assert.ok(errors[0].includes('No Ollama embedding model'))

    localEmbeddingProvider.removeListener('modelError', handler)
    localEmbeddingProvider.setBackend('omlx')
  })

  test('ensureEmbeddingReady returns false for offline Ollama', async () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    // Use an unroutable port to avoid accidental hits on machines with Ollama running
    localEmbeddingProvider.setOllamaBaseUrl('http://127.0.0.1:1')
    // Ollama not running → should return false, not throw
    const ready = await localEmbeddingProvider.ensureEmbeddingReady()
    assert.equal(ready, false, 'Should return false when Ollama is unreachable')
    // Cleanup
    localEmbeddingProvider.setBackend('omlx')
  })
})

describe('LocalEmbeddingProvider — oMLX event forwarding (C1 regression)', () => {
  test('omlx modelReady event propagates through facade when backend is omlx', () => {
    localEmbeddingProvider.setBackend('omlx')
    dropLeakedListeners()
    const events: string[] = []
    const handler = (): void => {
      events.push('modelReady')
    }
    localEmbeddingProvider.on('modelReady', handler)

    // Simulate oMLX emitting modelReady internally
    const { omlxEmbeddingProvider } = require('../omlx-embedding.service')
    omlxEmbeddingProvider.emit('modelReady')

    assert.equal(events.length, 1, 'Facade should forward omlx modelReady')
    localEmbeddingProvider.removeListener('modelReady', handler)
  })

  test('omlx modelError event propagates through facade when backend is omlx', () => {
    localEmbeddingProvider.setBackend('omlx')
    dropLeakedListeners()
    const errors: string[] = []
    const handler = (e: string): void => {
      errors.push(e)
    }
    localEmbeddingProvider.on('modelError', handler)

    const { omlxEmbeddingProvider } = require('../omlx-embedding.service')
    omlxEmbeddingProvider.emit('modelError', 'test error')

    assert.equal(errors.length, 1, 'Facade should forward omlx modelError')
    assert.equal(errors[0], 'test error')
    localEmbeddingProvider.removeListener('modelError', handler)
  })

  test('omlx events are NOT forwarded when backend is ollama (cross-backend gating)', () => {
    localEmbeddingProvider.setBackend('ollama')
    const events: string[] = []
    const readyHandler = (): void => {
      events.push('ready')
    }
    const errorHandler = (): void => {
      events.push('error')
    }
    localEmbeddingProvider.on('modelReady', readyHandler)
    localEmbeddingProvider.on('modelError', errorHandler)

    const { omlxEmbeddingProvider } = require('../omlx-embedding.service')
    omlxEmbeddingProvider.emit('modelReady')
    omlxEmbeddingProvider.emit('modelError', 'should be suppressed')

    assert.equal(events.length, 0, 'oMLX events should NOT leak when backend is ollama')
    localEmbeddingProvider.removeListener('modelReady', readyHandler)
    localEmbeddingProvider.removeListener('modelError', errorHandler)
    localEmbeddingProvider.setBackend('omlx')
  })
})

describe('LocalEmbeddingProvider — configureForWorkspace', () => {
  /**
   * Regression guard: the facade defaults to the oMLX backend, which cannot
   * work on Windows. configureForWorkspace() is what aligns it with the
   * workspace's persisted settings — if it stops selecting Ollama, embeddings
   * silently fail everywhere off Apple Silicon.
   */
  function withSettings(settings: Record<string, unknown>, fn: () => void): void {
    const original = workspaceRepository.getSettings
    ;(workspaceRepository as any).getSettings = () => settings
    try {
      fn()
    } finally {
      ;(workspaceRepository as any).getSettings = original
    }
  }

  test('selects the Ollama backend and applies model + base URL from settings', () => {
    localEmbeddingProvider.setBackend('omlx')
    localEmbeddingProvider.dispose()
    dropLeakedListeners()

    withSettings(
      {
        localLlmBackend: 'ollama',
        localHost: '192.168.1.50',
        localPort: 11500,
        ollamaEmbeddingModel: 'bge-m3'
      },
      () => {
        localEmbeddingProvider.configureForWorkspace('ws-1')
      }
    )

    // activeModelName reads the Ollama model only when the Ollama backend is active,
    // so this asserts both the backend switch and the model in one shot.
    assert.equal(localEmbeddingProvider.activeModelName, 'bge-m3')

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })

  test('leaves the oMLX backend selected when settings say omlx', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    dropLeakedListeners()

    withSettings({ localLlmBackend: 'omlx' }, () => {
      localEmbeddingProvider.configureForWorkspace('ws-2')
    })

    // Back on oMLX, activeModelName delegates to omlxEmbeddingProvider and must
    // no longer report the Ollama model.
    assert.notEqual(localEmbeddingProvider.activeModelName, 'bge-m3')

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })

  test('clears the model when settings no longer name one', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    dropLeakedListeners()

    withSettings({ localLlmBackend: 'ollama', ollamaEmbeddingModel: '' }, () => {
      localEmbeddingProvider.configureForWorkspace('ws-cleared')
    })

    assert.equal(
      localEmbeddingProvider.activeModelName,
      '',
      'a cleared selection must reach the facade'
    )

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })

  test('does not apply the Ollama model when the backend is omlx', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    dropLeakedListeners()

    // oMLX selects its embedding model server-side; the Ollama model name in
    // settings is not its business.
    withSettings({ localLlmBackend: 'omlx', ollamaEmbeddingModel: 'nomic-embed-text' }, () => {
      localEmbeddingProvider.configureForWorkspace('ws-omlx')
    })

    localEmbeddingProvider.setBackend('ollama')
    assert.equal(localEmbeddingProvider.activeModelName, 'bge-m3')

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })

  /**
   * Only fully discriminating off Apple Silicon (where the old hardcoded
   * 'omlx' fallback was the bug); on Apple Silicon both agree by definition.
   */
  test('falls back to the platform default when no backend is persisted', () => {
    const expected = defaultLocalLlmBackend(
      process.platform === 'darwin' && process.arch === 'arm64'
    )
    localEmbeddingProvider.setBackend(expected === 'omlx' ? 'ollama' : 'omlx')
    dropLeakedListeners()

    withSettings({}, () => {
      localEmbeddingProvider.configureForWorkspace('ws-no-backend')
    })

    assert.equal(localEmbeddingProvider.activeBackend, expected)

    localEmbeddingProvider.dispose()
    localEmbeddingProvider.setBackend('omlx')
  })

  test('does not throw when settings lookup fails', () => {
    const original = workspaceRepository.getSettings
    ;(workspaceRepository as any).getSettings = () => {
      throw new Error('db unavailable')
    }
    try {
      localEmbeddingProvider.configureForWorkspace('missing-ws')
    } finally {
      ;(workspaceRepository as any).getSettings = original
      localEmbeddingProvider.setBackend('omlx')
    }
  })
})

describe('LocalEmbeddingProvider — dispose resets state', () => {
  test('dispose clears ollama state', () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('nomic-embed-text')
    assert.equal(localEmbeddingProvider.activeModelName, 'nomic-embed-text')

    localEmbeddingProvider.dispose()
    assert.equal(localEmbeddingProvider.isReady, false)
    assert.equal(localEmbeddingProvider.activeModelName, '')

    // Cleanup
    localEmbeddingProvider.setBackend('omlx')
  })

  test('dispose always cleans up oMLX state (M5 fix)', () => {
    // Even when backend is ollama, dispose should clean up oMLX to prevent leaks
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.setOllamaEmbeddingModel('bge-m3')
    // dispose should not throw and should reset all state
    localEmbeddingProvider.dispose()
    assert.equal(localEmbeddingProvider.isReady, false)
    localEmbeddingProvider.setBackend('omlx')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()

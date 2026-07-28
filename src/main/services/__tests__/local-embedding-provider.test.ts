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

describe('LocalEmbeddingProvider — interface contract', () => {
  test('exports singleton instance', () => {
    assert.ok(localEmbeddingProvider, 'localEmbeddingProvider should be exported')
    assert.equal(typeof localEmbeddingProvider.embed, 'function', 'embed() method')
    assert.equal(typeof localEmbeddingProvider.initialize, 'function', 'initialize() method')
    assert.equal(typeof localEmbeddingProvider.dispose, 'function', 'dispose() method')
    assert.equal(typeof localEmbeddingProvider.reinitialize, 'function', 'reinitialize() method')
    assert.equal(typeof localEmbeddingProvider.ensureEmbeddingReady, 'function', 'ensureEmbeddingReady() method')
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
})

describe('LocalEmbeddingProvider — Ollama error handling', () => {
  test('initialize with ollama backend and no model emits modelError', async () => {
    localEmbeddingProvider.setBackend('ollama')
    localEmbeddingProvider.dispose() // clear any previous model

    const errors: string[] = []
    const handler = (e: string): void => { errors.push(e) }
    localEmbeddingProvider.on('modelError', handler)

    try {
      await localEmbeddingProvider.initialize()
      assert.fail('Should have thrown when no model configured')
    } catch (err) {
      assert.ok(err instanceof Error)
      assert.ok(err.message.includes('No Ollama embedding model'), `Error should mention model: ${err.message}`)
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
    const events: string[] = []
    const handler = (): void => { events.push('modelReady') }
    localEmbeddingProvider.on('modelReady', handler)

    // Simulate oMLX emitting modelReady internally
    const { omlxEmbeddingProvider } = require('../omlx-embedding.service')
    omlxEmbeddingProvider.emit('modelReady')

    assert.equal(events.length, 1, 'Facade should forward omlx modelReady')
    localEmbeddingProvider.removeListener('modelReady', handler)
  })

  test('omlx modelError event propagates through facade when backend is omlx', () => {
    localEmbeddingProvider.setBackend('omlx')
    const errors: string[] = []
    const handler = (e: string): void => { errors.push(e) }
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
    const readyHandler = (): void => { events.push('ready') }
    const errorHandler = (): void => { events.push('error') }
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

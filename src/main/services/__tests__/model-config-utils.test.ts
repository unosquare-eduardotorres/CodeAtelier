/**
 * Tests for pure utility methods in ModelConfigService:
 *   - getLocalBaseUrl (URL construction)
 *   - getOllamaBaseUrl (deprecated wrapper)
 *   - fallbackAction (private — tested via `as any`)
 *
 * These methods have zero DB or electron dependencies — they're pure functions
 * on the singleton instance. DB-bound methods (getModel, getProvider, etc.)
 * are NOT tested here.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { modelConfigService } from '../model-config.service'
import {
  DEFAULT_MODEL_CONFIG,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT
} from '../../../shared/constants'
import type { LocalLLMConfig } from '../../../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<LocalLLMConfig> = {}): LocalLLMConfig {
  return {
    provider: 'local-llm',
    backend: 'ollama',
    localModel: 'qwen3.6:35b-a3b-coding-nvfp4',
    localHost: OLLAMA_DEFAULT_HOST,
    localPort: OLLAMA_DEFAULT_PORT,
    strategy: 'default',
    ...overrides
  }
}

// ── getLocalBaseUrl ─────────────────────────────────────────────────────

describe('ModelConfigService.getLocalBaseUrl', () => {
  test('default host:port → http://127.0.0.1:11434', () => {
    const url = modelConfigService.getLocalBaseUrl(makeConfig())
    assert.equal(url, `http://${OLLAMA_DEFAULT_HOST}:${OLLAMA_DEFAULT_PORT}`)
  })

  test('custom host:port', () => {
    const url = modelConfigService.getLocalBaseUrl(
      makeConfig({ localHost: '192.168.1.10', localPort: 9090 })
    )
    assert.equal(url, 'http://192.168.1.10:9090')
  })

  test('oMLX default port', () => {
    const url = modelConfigService.getLocalBaseUrl(
      makeConfig({ backend: 'omlx', localPort: OMLX_DEFAULT_PORT })
    )
    assert.equal(url, `http://${OLLAMA_DEFAULT_HOST}:${OMLX_DEFAULT_PORT}`)
  })
})

// ── getOllamaBaseUrl (deprecated wrapper) ───────────────────────────────

describe('ModelConfigService.getOllamaBaseUrl', () => {
  test('delegates to getLocalBaseUrl — same result', () => {
    const config = makeConfig()
    const local = modelConfigService.getLocalBaseUrl(config)
    const ollama = modelConfigService.getOllamaBaseUrl(config)
    assert.equal(ollama, local)
  })
})

// ── fallbackAction (private) ────────────────────────────────────────────

describe('ModelConfigService.fallbackAction (private)', () => {
  const fallback = (action: string) =>
    (modelConfigService as any).fallbackAction(action)

  test('sub-action "da-vinci:plan" → falls back to "da-vinci" base', () => {
    const result = fallback('da-vinci:plan')
    assert.equal(result, DEFAULT_MODEL_CONFIG['da-vinci'])
  })

  test('direct action "da-vinci" → looks up directly', () => {
    const result = fallback('da-vinci')
    assert.equal(result, DEFAULT_MODEL_CONFIG['da-vinci'])
  })

  test('unknown base action → falls back to DEFAULT_MODEL_CONFIG["da-vinci"]', () => {
    const result = fallback('unknown-action:sub')
    assert.equal(result, DEFAULT_MODEL_CONFIG['da-vinci'])
  })

  test('empty string → falls back to da-vinci default', () => {
    const result = fallback('')
    assert.equal(result, DEFAULT_MODEL_CONFIG['da-vinci'])
  })
})

// ── Summary ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

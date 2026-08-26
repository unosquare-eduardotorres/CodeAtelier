/**
 * Local Models draft — pure draft/diff rules.
 *
 * Two defects this pins down:
 *   1. The backend tab used to sit outside the dirty comparison, so switching
 *      oMLX → Ollama on an already-correct port produced no Unsaved chip, no
 *      Save button, and the tab was never persisted.
 *   2. Saves used to post the whole settings object read back from main, which
 *      reverted every key another page had written since this one loaded.
 *
 * Run: tsx src/renderer/src/components/workspace/model-config/__tests__/local-models-draft.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../main/services/__tests__/test-harness'
import {
  changedLocalModelsSettings,
  defaultLocalModelsDraft,
  localModelsDraftsEqual,
  type LocalModelsDraft
} from '../local-models-draft'

function saved(): LocalModelsDraft {
  return {
    localLlmBackend: 'ollama',
    localHost: '127.0.0.1',
    localPort: 11434,
    localApiKey: '',
    localContextWindow: undefined,
    localModel: 'qwen3:8b',
    ollamaEmbeddingModel: 'bge-m3'
  }
}

describe('localModelsDraftsEqual — dirty computation', () => {
  test('an untouched draft is clean', () => {
    assert.equal(localModelsDraftsEqual(saved(), saved()), true)
  })

  /**
   * The exact reported scenario: the port already matches Ollama's default, so
   * nothing in the old connection-only comparison changed — yet the user did
   * change something that must be saved.
   */
  test('switching the backend tab alone is dirty, even with an unchanged port', () => {
    const persisted = saved()
    const draft: LocalModelsDraft = { ...persisted, localLlmBackend: 'omlx' }
    assert.equal(localModelsDraftsEqual(draft, persisted), false)
  })

  test('selecting a different chat model is dirty', () => {
    const persisted = saved()
    assert.equal(localModelsDraftsEqual({ ...persisted, localModel: 'llama3.1' }, persisted), false)
  })

  test('selecting a different embedding model is dirty', () => {
    const persisted = saved()
    assert.equal(
      localModelsDraftsEqual({ ...persisted, ollamaEmbeddingModel: 'nomic-embed-text' }, persisted),
      false
    )
  })

  test('clearing the embedding model is dirty', () => {
    const persisted = saved()
    assert.equal(
      localModelsDraftsEqual({ ...persisted, ollamaEmbeddingModel: '' }, persisted),
      false
    )
  })

  test('connection fields still count', () => {
    const persisted = saved()
    assert.equal(localModelsDraftsEqual({ ...persisted, localHost: '10.0.0.4' }, persisted), false)
    assert.equal(localModelsDraftsEqual({ ...persisted, localPort: 9999 }, persisted), false)
    assert.equal(localModelsDraftsEqual({ ...persisted, localApiKey: 'k' }, persisted), false)
    assert.equal(
      localModelsDraftsEqual({ ...persisted, localContextWindow: 32000 }, persisted),
      false
    )
  })
})

describe('changedLocalModelsSettings — save payload', () => {
  test('emits nothing when the draft is clean', () => {
    assert.deepEqual(changedLocalModelsSettings(saved(), saved()), {})
  })

  /**
   * The payload must not carry untouched keys: main merges it over the stored
   * row, so every key present is a key this page overwrites.
   */
  test('emits ONLY the changed key', () => {
    const persisted = saved()
    const draft: LocalModelsDraft = { ...persisted, ollamaEmbeddingModel: 'nomic-embed-text' }
    assert.deepEqual(changedLocalModelsSettings(draft, persisted), {
      ollamaEmbeddingModel: 'nomic-embed-text'
    })
  })

  test('emits every changed key when several move at once', () => {
    const persisted = saved()
    const draft: LocalModelsDraft = {
      ...persisted,
      localLlmBackend: 'omlx',
      localPort: 8000,
      localModel: 'mlx-community/Qwen3'
    }
    assert.deepEqual(changedLocalModelsSettings(draft, persisted), {
      localLlmBackend: 'omlx',
      localPort: 8000,
      localModel: 'mlx-community/Qwen3'
    })
  })

  test('a cleared embedding model is emitted as an empty string, not dropped', () => {
    const persisted = saved()
    const payload = changedLocalModelsSettings(
      { ...persisted, ollamaEmbeddingModel: '' },
      persisted
    )
    assert.ok('ollamaEmbeddingModel' in payload, 'the clear must be sent, not omitted')
    assert.equal(payload.ollamaEmbeddingModel, '')
  })

  test('a cleared context-window override is sent as null (undefined is lost over IPC)', () => {
    const persisted: LocalModelsDraft = { ...saved(), localContextWindow: 32000 }
    const payload = changedLocalModelsSettings(
      { ...persisted, localContextWindow: undefined },
      persisted
    )
    assert.equal(payload.localContextWindow, null)
  })
})

describe('discard semantics', () => {
  test('restoring from persisted makes the draft clean again', () => {
    const persisted = saved()
    const draft: LocalModelsDraft = {
      ...persisted,
      localLlmBackend: 'omlx',
      ollamaEmbeddingModel: ''
    }
    assert.equal(localModelsDraftsEqual(draft, persisted), false)

    const discarded = { ...persisted }
    assert.equal(localModelsDraftsEqual(discarded, persisted), true)
    assert.deepEqual(changedLocalModelsSettings(discarded, persisted), {})
  })
})

describe('defaultLocalModelsDraft', () => {
  test('is self-consistent (a fresh draft is not dirty against itself)', () => {
    assert.equal(localModelsDraftsEqual(defaultLocalModelsDraft(), defaultLocalModelsDraft()), true)
    assert.deepEqual(
      changedLocalModelsSettings(defaultLocalModelsDraft(), defaultLocalModelsDraft()),
      {}
    )
  })
})

if (process.argv[1]?.includes('local-models-draft')) {
  void summaryAsync()
}

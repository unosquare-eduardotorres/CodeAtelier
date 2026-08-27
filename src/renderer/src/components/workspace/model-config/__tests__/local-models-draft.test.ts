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
  changedRoutingSettings,
  countUnsavedChanges,
  defaultLocalModelsDraft,
  defaultRoutingDraft,
  deriveProvider,
  localModelsDraftsEqual,
  routingDraftsEqual,
  type LocalModelsDraft,
  type RoutingDraft
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

// ─── Routing draft ──────────────────────────────────

function savedRouting(): RoutingDraft {
  return {
    modelRoles: {
      'specialist:plan': { provider: 'claude', modelId: 'claude-opus-5' }
    },
    modelOverrides: { 'specialist:plan': 'claude-opus-5' },
    fallbackModel: 'claude-sonnet-5',
    communicationTone: 'default'
  }
}

describe('routingDraftsEqual — dirty computation', () => {
  test('an untouched routing draft is clean', () => {
    assert.equal(routingDraftsEqual(savedRouting(), savedRouting()), true)
  })

  /**
   * Role maps are rebuilt on every edit, so a reference comparison would report
   * every render as dirty and a shallow one would miss a changed model id.
   */
  test('an equal-but-not-identical role map is clean', () => {
    const a = savedRouting()
    const b = savedRouting()
    assert.notEqual(a.modelRoles, b.modelRoles)
    assert.equal(routingDraftsEqual(a, b), true)
  })

  test('routing a role to a different model is dirty', () => {
    const persisted = savedRouting()
    const draft: RoutingDraft = {
      ...persisted,
      modelRoles: { 'specialist:plan': { provider: 'claude', modelId: 'claude-sonnet-5' } }
    }
    assert.equal(routingDraftsEqual(draft, persisted), false)
  })

  /** The exact defect #5 shape: same model, different backend recorded. */
  test('the same local model on a different backend is dirty', () => {
    const persisted: RoutingDraft = {
      ...savedRouting(),
      modelRoles: {
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'omlx' }
      }
    }
    const draft: RoutingDraft = {
      ...persisted,
      modelRoles: {
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'ollama' }
      }
    }
    assert.equal(routingDraftsEqual(draft, persisted), false)
  })

  test('adding a role that was previously unset is dirty', () => {
    const persisted = savedRouting()
    const draft: RoutingDraft = {
      ...persisted,
      modelRoles: {
        ...persisted.modelRoles,
        audit: { provider: 'claude', modelId: 'claude-opus-5' }
      }
    }
    assert.equal(routingDraftsEqual(draft, persisted), false)
  })

  test('changing the fallback model or the tone is dirty', () => {
    const persisted = savedRouting()
    assert.equal(
      routingDraftsEqual({ ...persisted, fallbackModel: 'claude-opus-5' }, persisted),
      false
    )
    assert.equal(
      routingDraftsEqual({ ...persisted, communicationTone: 'brutal' }, persisted),
      false
    )
  })
})

describe('changedRoutingSettings — save payload', () => {
  test('emits nothing when the routing draft is clean', () => {
    assert.deepEqual(changedRoutingSettings(savedRouting(), savedRouting(), 'ollama'), {})
  })

  test('a tone change emits only the tone', () => {
    const persisted = savedRouting()
    assert.deepEqual(
      changedRoutingSettings({ ...persisted, communicationTone: 'brutal' }, persisted, 'ollama'),
      { communicationTone: 'brutal' }
    )
  })

  /**
   * `llmProvider` is what the backend reads for anything not routed per-action.
   * Leaving it stale is how a workspace ends up routed to a local model while
   * still reporting `claude`.
   */
  test('routing to a local model carries llmProvider and the active backend', () => {
    const persisted = savedRouting()
    const draft: RoutingDraft = {
      ...persisted,
      modelRoles: {
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'ollama' }
      }
    }
    const payload = changedRoutingSettings(draft, persisted, 'ollama')
    assert.equal(payload.llmProvider, 'local-llm')
    assert.equal(payload.localLlmBackend, 'ollama')
    assert.ok('modelRoles' in payload)
  })

  test('routing back to Claude does not record a local backend', () => {
    const persisted: RoutingDraft = {
      ...savedRouting(),
      modelRoles: {
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'ollama' }
      }
    }
    const payload = changedRoutingSettings(savedRouting(), persisted, 'ollama')
    assert.equal(payload.llmProvider, 'claude')
    assert.equal('localLlmBackend' in payload, false)
  })

  test('a cleared fallback is sent as null, not dropped', () => {
    const persisted = savedRouting()
    const payload = changedRoutingSettings(
      { ...persisted, fallbackModel: undefined },
      persisted,
      'omlx'
    )
    assert.ok('fallbackModel' in payload)
    assert.equal(payload.fallbackModel, null)
  })

  test('an untouched aspect never appears in the payload', () => {
    const persisted = savedRouting()
    const payload = changedRoutingSettings(
      { ...persisted, fallbackModel: 'claude-opus-5' },
      persisted,
      'omlx'
    )
    assert.deepEqual(Object.keys(payload), ['fallbackModel'])
  })
})

describe('discarding the routing draft', () => {
  test('restoring from persisted clears both the dirty flag and the payload', () => {
    const persisted = savedRouting()
    const draft: RoutingDraft = { ...persisted, communicationTone: 'brutal' }
    assert.equal(routingDraftsEqual(draft, persisted), false)

    const discarded = { ...persisted }
    assert.equal(routingDraftsEqual(discarded, persisted), true)
    assert.deepEqual(changedRoutingSettings(discarded, persisted, 'ollama'), {})
  })
})

describe('deriveProvider', () => {
  test('reads the plan role', () => {
    assert.equal(
      deriveProvider({
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'ollama' }
      }),
      'local-llm'
    )
  })

  test('an unrouted plan role means Claude', () => {
    assert.equal(deriveProvider({}), 'claude')
  })
})

describe('countUnsavedChanges — what the save bar reports', () => {
  const clean = (): {
    local: { draft: LocalModelsDraft; persisted: LocalModelsDraft }
    routing: { draft: RoutingDraft; persisted: RoutingDraft }
  } => ({
    local: { draft: saved(), persisted: saved() },
    routing: { draft: savedRouting(), persisted: savedRouting() }
  })

  test('reports zero when nothing is pending', () => {
    const s = clean()
    assert.equal(countUnsavedChanges(s.local, s.routing), 0)
  })

  test('counts connection and routing edits together', () => {
    const s = clean()
    s.local.draft = { ...s.local.draft, localPort: 9999 }
    s.routing.draft = { ...s.routing.draft, communicationTone: 'brutal' }
    assert.equal(countUnsavedChanges(s.local, s.routing), 2)
  })

  /**
   * One routing edit is one decision. `llmProvider` and `localLlmBackend` ride
   * along in the payload as consequences; counting them would report "3 unsaved
   * changes" for a single dropdown.
   */
  test('one routing edit counts once, not once per emitted key', () => {
    const s = clean()
    s.routing.draft = {
      ...s.routing.draft,
      modelRoles: {
        'specialist:plan': { provider: 'local-llm', modelId: 'qwen3:8b', localBackend: 'ollama' }
      }
    }
    const payload = changedRoutingSettings(s.routing.draft, s.routing.persisted, 'ollama')
    assert.ok(Object.keys(payload).length > 1, 'the payload does carry consequences')
    assert.equal(countUnsavedChanges(s.local, s.routing), 1)
  })
})

describe('defaultRoutingDraft', () => {
  test('is self-consistent (a fresh draft is not dirty against itself)', () => {
    assert.equal(routingDraftsEqual(defaultRoutingDraft(), defaultRoutingDraft()), true)
    assert.deepEqual(
      changedRoutingSettings(defaultRoutingDraft(), defaultRoutingDraft(), 'omlx'),
      {}
    )
  })
})

if (process.argv[1]?.includes('local-models-draft')) {
  void summaryAsync()
}

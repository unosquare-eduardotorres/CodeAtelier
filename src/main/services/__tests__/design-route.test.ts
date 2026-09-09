/**
 * design-route.service — brief → preselected commands.
 *
 * Two properties carry the feature, and both are pinned here:
 *
 * 1. **It never blocks the wizard.** Every failure mode of the model call —
 *    timeout, throw, empty text, prose instead of JSON, JSON with no usable ids
 *    — must degrade to the deterministic keyword table, not reject.
 * 2. **A model cannot preselect an invalid set.** `parseDesignRunConfig` throws
 *    on an unknown id or an incompatible pair, so a hallucinated `shape` or a
 *    `bolder` + `quieter` answer would turn a helpful preselect into an
 *    unexplained failure when the user hits Run.
 *
 * Run: tsx src/main/services/__tests__/design-route.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, runExclusive, summaryAsync } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  evictFromCache,
  mockService,
  unmockService
} from './setup-full-mock'

setupFullMock()

/**
 * Control the model-resolution layer directly, the way
 * `blueprint-model-snapshot-refresh.test.ts` does and for the same reason:
 * several suites in the shared run register their own
 * `mockService('model-config.service', …)` and never unregister it, so the real
 * `resolveAssignment` is NOT reliably what `design-route.service` binds to in a
 * full run. Standalone-green proved nothing here — the C3 regression test below
 * failed in the full run for exactly this reason before this block existed.
 *
 * The stub keeps the one rule the test is pinning: an assignment is honoured
 * only when a role exists for the action, so a service that consults the WRONG
 * action (or none at all — the C3 bug) still falls through to `localModel`.
 */
const liveRoles: { modelRoles: Record<string, { provider: string; modelId: string }> } = {
  modelRoles: {}
}
mockService('model-config.service', {
  resolveAssignment: (opts: {
    action: string
    modelRoles?: Record<string, { provider: string; modelId: string }>
  }) => {
    const role = opts?.modelRoles?.[opts.action]
    if (role) return { provider: role.provider, modelId: role.modelId, source: 'roles' }
    return { provider: 'claude', modelId: 'claude-haiku-4-5-20251001', source: 'default' }
  },
  buildResolveOpts: () => ({
    modelRoles: liveRoles.modelRoles,
    modelOverrides: undefined,
    workspaceProvider: 'local-llm',
    workspaceBackend: undefined
  }),
  modelConfigService: {
    getModelById: () => 'claude-haiku-4-5-20251001',
    getLocalLLMConfig: () => ({}),
    getLocalBaseUrl: () => 'http://127.0.0.1:1234/v1'
  }
})

evictFromCache('services/design-route.service')

const routeModule = require('../design-route.service') as typeof import('../design-route.service')
const {
  designRouteService,
  keywordRoute,
  sanitizeCommandIds,
  parseRouteResponse,
  MAX_ROUTED_COMMANDS
} = routeModule

// serviceMocks is process-global and survives restoreFullMock() — unregister so
// this stub cannot hijack a later file's model-config imports.
unmockService('model-config.service')

const { validateDesignCommandSet, evaluateCommandsSelected } =
  require('../../../shared/design-commands') as typeof import('../../../shared/design-commands')

const WS = 'ws-route'

/** Point the workspace lookups at a Claude workspace with a repo path. */
function stubClaudeWorkspace(): void {
  const repo = getMockRepo('workspace')
  repo.getSettings.mockReset().mockReturnValue({ llmProvider: 'claude' })
  repo.findById.mockReset().mockReturnValue({ id: WS, repoPath: '/tmp/ws' })
}

/**
 * Drive `route` with a stubbed model response.
 *
 * `runExclusive` because the service singleton's `_localRunner` and the shared
 * repository spies are process-global: the harness runs tests within a describe
 * concurrently, so two overlapping cases would answer each other's model calls.
 * The seam is cleared in a `finally` for the same reason — a leaked stub is the
 * P3.7.8 lesson.
 */
function routeWith(
  brief: string,
  respond: () => Promise<{ text: string }>
): Promise<Awaited<ReturnType<typeof designRouteService.route>>> {
  return runExclusive(async () => {
    stubClaudeWorkspace()
    designRouteService._localRunner = respond
    try {
      return await designRouteService.route({ workspaceId: WS, brief })
    } finally {
      designRouteService._localRunner = undefined
    }
  })
}

// ── §1: the keyword table (the floor everything degrades to) ─────────────────

describe('keywordRoute', () => {
  test('maps the documented intents', () => {
    assert.deepEqual(keywordRoute('I want to animate this user page'), ['critique', 'animate'])
    assert.deepEqual(keywordRoute('audit the current UX'), ['audit', 'critique'])
    assert.deepEqual(keywordRoute('make the hero bolder'), ['critique', 'bolder'])
    assert.deepEqual(keywordRoute('this page feels generic and AI-made'), ['critique', 'distill'])
  })

  test('always includes an evaluate pass, because refine cards never execute', () => {
    // 'animate' alone would start a run with no pass to attach findings to.
    for (const brief of ['animate it', 'fix the typography', 'add colour', '', 'zzzz']) {
      const ids = keywordRoute(brief)
      assert.ok(
        evaluateCommandsSelected(ids).length > 0,
        `"${brief}" produced no evaluate command: ${ids.join(',')}`
      )
    }
  })

  test('an unrecognised brief still yields a runnable selection', () => {
    assert.deepEqual(keywordRoute('qqqq wwww'), ['critique'])
  })

  test('never emits an incompatible pair', () => {
    // "calm and bold" names both sides of the quieter/bolder clash.
    const ids = keywordRoute('make it calmer but also bolder and more striking')
    assert.ok(validateDesignCommandSet(ids).valid, `conflicting selection: ${ids.join(',')}`)
  })
})

// ── §2: selection sanitisation ───────────────────────────────────────────────

describe('sanitizeCommandIds', () => {
  test('drops ids that are not in the catalogue', () => {
    // 'shape' and 'overdrive' are real engine commands deliberately excluded
    // from the cards; a model that has read the engine docs will suggest them.
    assert.deepEqual(sanitizeCommandIds(['audit', 'shape', 'overdrive', 'nonsense']), ['audit'])
  })

  test('resolves an incompatible pair by keeping the first', () => {
    assert.deepEqual(sanitizeCommandIds(['critique', 'bolder', 'quieter']), ['critique', 'bolder'])
    assert.deepEqual(sanitizeCommandIds(['critique', 'quieter', 'bolder']), ['critique', 'quieter'])
  })

  test('drops every card distill rules out', () => {
    const ids = sanitizeCommandIds([
      'critique',
      'distill',
      'animate',
      'bolder',
      'colorize',
      'delight'
    ])
    assert.deepEqual(ids, ['critique', 'distill'])
    assert.ok(validateDesignCommandSet(ids).valid)
  })

  test('de-duplicates', () => {
    assert.deepEqual(sanitizeCommandIds(['audit', 'audit', 'audit']), ['audit'])
  })

  test('caps the number of preselected cards', () => {
    // A model returning the whole catalogue has not routed anything.
    const all = ['layout', 'typeset', 'adapt', 'clarify', 'harden', 'onboard', 'optimize', 'polish']
    const ids = sanitizeCommandIds(all)
    assert.ok(ids.length <= MAX_ROUTED_COMMANDS, `got ${ids.length}`)
    assert.ok(evaluateCommandsSelected(ids).length > 0)
  })

  test('prepends the evaluate pass when a selection is all refine cards', () => {
    assert.deepEqual(sanitizeCommandIds(['animate', 'layout']), ['critique', 'animate', 'layout'])
  })

  test('an empty candidate list still yields a runnable selection', () => {
    assert.deepEqual(sanitizeCommandIds([]), ['critique'])
  })
})

// ── §3: response parsing ─────────────────────────────────────────────────────

describe('parseRouteResponse', () => {
  test('reads a bare JSON object', () => {
    const r = parseRouteResponse('{"commandIds":["critique"],"scopeHint":"src","rationale":"hi"}')
    assert.deepEqual(r?.commandIds, ['critique'])
    assert.equal(r?.scopeHint, 'src')
    assert.equal(r?.rationale, 'hi')
  })

  test('survives fences, prose, and local-model <think> leakage', () => {
    const messy = `<think>the user wants motion</think>
Here you go:
\`\`\`json
{"commandIds":["critique","animate"],"scopeHint":null,"rationale":"Motion."}
\`\`\``
    assert.deepEqual(parseRouteResponse(messy)?.commandIds, ['critique', 'animate'])
  })

  test('returns null for prose, empty text, and malformed JSON', () => {
    assert.equal(parseRouteResponse('I think you should audit it.'), null)
    assert.equal(parseRouteResponse(''), null)
    assert.equal(parseRouteResponse('{"commandIds": [oops}'), null)
  })

  test('returns null when commandIds is missing or has no strings', () => {
    assert.equal(parseRouteResponse('{"rationale":"none"}'), null)
    assert.equal(parseRouteResponse('{"commandIds":[1,2,3]}'), null)
  })

  test('drops an over-long scope hint rather than carrying a non-path', () => {
    const r = parseRouteResponse(
      `{"commandIds":["audit"],"scopeHint":"${'a'.repeat(500)}","rationale":""}`
    )
    assert.equal(r?.scopeHint, null)
  })
})

// ── §4: the degradation contract ─────────────────────────────────────────────

describe('route — never blocks the wizard', () => {
  test('a model answer is used when it is valid', async () => {
    const result = await routeWith('this dashboard feels noisy', async () => ({
      text: '{"commandIds":["critique","quieter"],"scopeHint":"src/renderer","rationale":"Calmer."}'
    }))
    assert.deepEqual(result.commandIds, ['critique', 'quieter'])
    assert.equal(result.scopeHint, 'src/renderer')
    assert.equal(result.rationale, 'Calmer.')
    assert.equal(result.usedFallback, false)
  })

  test('a thrown model call falls back instead of rejecting', async () => {
    const result = await routeWith('I want to animate this user page', async () => {
      throw new Error('ETIMEDOUT')
    })
    assert.equal(result.usedFallback, true)
    assert.deepEqual(result.commandIds, ['critique', 'animate'])
  })

  test('an empty response falls back', async () => {
    const result = await routeWith('audit the UX', async () => ({ text: '   ' }))
    assert.equal(result.usedFallback, true)
    assert.deepEqual(result.commandIds, ['audit', 'critique'])
  })

  test('an unparseable response falls back', async () => {
    const result = await routeWith('make it bolder', async () => ({
      text: 'Sure! I would recommend the bolder command.'
    }))
    assert.equal(result.usedFallback, true)
    assert.deepEqual(result.commandIds, ['critique', 'bolder'])
  })

  test('an empty brief never reaches the model', async () => {
    let called = false
    const result = await routeWith('   ', async () => {
      called = true
      return { text: '{"commandIds":["audit"]}' }
    })
    assert.equal(called, false, 'no point paying for a round trip on an empty brief')
    assert.equal(result.usedFallback, true)
    assert.deepEqual(result.commandIds, ['critique'])
  })

  test('a fallback result is always valid and never carries a scope hint', async () => {
    const result = await routeWith('anything', async () => {
      throw new Error('boom')
    })
    assert.ok(validateDesignCommandSet(result.commandIds).valid)
    assert.equal(result.scopeHint, null)
    assert.ok(result.rationale.length > 0, 'the UI shows this line next to the cards')
  })
})

// ── §4b: the local-model assignment (C3) ──────────────────────────────────

describe('resolveLocalModel', () => {
  /**
   * Mirrors `prompt-optimizer.test.ts`. Before this existed, the local branch of
   * `callModel` read `localCfg.localModel` directly — so the Design → Route row
   * in model settings had NO EFFECT on a local-LLM workspace, exactly the class
   * of bug P3.7.2 fixed for Design → Evaluate two phases earlier.
   */
  /** `liveRoles` is module-global, so every case here takes the shared lock. */
  function withRoles<T>(
    modelRoles: Record<string, { provider: string; modelId: string }>,
    fn: () => T
  ): Promise<T> {
    return runExclusive(async () => {
      liveRoles.modelRoles = modelRoles
      try {
        return fn()
      } finally {
        liveRoles.modelRoles = {}
      }
    })
  }

  test('REGRESSION: an explicit local role for design:route is honoured', () =>
    withRoles({ 'design:route': { provider: 'local-llm', modelId: 'my-local' } }, () => {
      assert.equal(
        designRouteService.resolveLocalModel(WS, { localModel: 'fallback-model' }),
        'my-local'
      )
    }))

  test('a role for a DIFFERENT action is not borrowed', () =>
    withRoles({ 'prompt:optimize': { provider: 'local-llm', modelId: 'not-mine' } }, () => {
      assert.equal(
        designRouteService.resolveLocalModel(WS, { localModel: 'fallback-model' }),
        'fallback-model'
      )
    }))

  test('a default assignment falls back to the configured local model, not a Claude id', () =>
    withRoles({}, () => {
      // The default for `design:route` is a Claude model, which the local server
      // 404s on — so a non-local assignment must NOT be honoured here.
      const model = designRouteService.resolveLocalModel(WS, { localModel: 'Qwen3-35B-MLX' })
      assert.equal(model, 'Qwen3-35B-MLX')
      assert.ok(!model.startsWith('claude-'), `expected a local model, got ${model}`)
    }))

  test('no local model configured falls back to qwen3-coder', () =>
    withRoles({}, () => {
      assert.equal(designRouteService.resolveLocalModel(WS, {}), 'qwen3-coder')
    }))
})

describe('route — a model cannot preselect an invalid set', () => {
  test('hallucinated ids are filtered out of the answer', async () => {
    const result = await routeWith('review the shape of this page', async () => ({
      text: '{"commandIds":["shape","critique","teleport"],"scopeHint":null,"rationale":"x"}'
    }))
    assert.deepEqual(result.commandIds, ['critique'])
    assert.equal(result.usedFallback, false, 'one bad id does not discard a usable answer')
  })

  test('an incompatible pair is resolved, not passed through', async () => {
    const result = await routeWith('bold but calm', async () => ({
      text: '{"commandIds":["critique","bolder","quieter"],"scopeHint":null,"rationale":"x"}'
    }))
    assert.ok(validateDesignCommandSet(result.commandIds).valid)
    assert.deepEqual(result.commandIds, ['critique', 'bolder'])
  })

  test('an all-refine answer gains the evaluate pass that actually runs', async () => {
    const result = await routeWith('animate it', async () => ({
      text: '{"commandIds":["animate","layout"],"scopeHint":null,"rationale":"x"}'
    }))
    assert.ok(evaluateCommandsSelected(result.commandIds).length > 0)
  })

  test('an answer of nothing but unknown ids falls back to keywords', async () => {
    const result = await routeWith('make the typography consistent', async () => ({
      text: '{"commandIds":["shape","init","document"],"scopeHint":null,"rationale":"x"}'
    }))
    assert.equal(result.usedFallback, true)
    assert.ok(result.commandIds.includes('typeset'))
  })

  // The mock repositories are process-global and outlive this file. Leaving
  // `workspaceRepository.findById` stubbed to RETURN a workspace is not inert:
  // later IPC suites assert a handler rejects *because* the lookup came back
  // empty (`codeGraph:indexStart` throws 'Workspace not found'), and a stub that
  // always finds one turns that rejection into a silent pass. Caught in the full
  // run — this suite is green standalone either way. Same restore contract
  // `design-orchestration.test.ts` carries.
  test('restores the shared repository spies for later suites', () =>
    runExclusive(async () => {
      const workspace = getMockRepo('workspace')
      workspace.findById.mockReset()
      workspace.getSettings.mockReset()
      assert.equal(designRouteService._localRunner, undefined, 'the model seam must not leak')
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

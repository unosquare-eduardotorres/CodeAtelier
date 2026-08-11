/**
 * blueprint-clarify-resurface.test.ts
 *
 * Regression cover for two ways a CLARIFY turn silently degraded from the
 * structured question cards to the free-text "Awaiting your answer" panel:
 *
 *  1. RE-SURFACE-FIX — dedupe ran against every question ever displayed, so the
 *     re-emission the clarify prompt explicitly asks for ("Session Resume:
 *     re-emit ... any unanswered questions block") was dropped wholesale and the
 *     turn fell through to awaitingInput. Once that happened the user had no
 *     route back to the options: asking "provide the questions again" re-entered
 *     the same path forever.
 *
 *  2. NUDGE-FINDINGS-FIX — the corrective nudge only fired when ZERO blocks
 *     parsed, so a findings-only turn (no questions, no completion) skipped the
 *     nudge and went straight to the free-text fallback.
 *
 * Drives the real BlueprintSpecService.handleClarifyTurnEnd with the
 * blueprintService singleton's machine/state hooks patched.
 *
 * Run: tsx src/main/services/__tests__/blueprint-clarify-resurface.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let BlueprintSpecService: any
let CLARIFY_CORRECTION_MESSAGE: string
let blueprintServiceSingleton: any
let clarifyQuestionKey: any
let loaded = false

try {
  const mod = require('../blueprint-spec.service')
  BlueprintSpecService = mod.BlueprintSpecService
  CLARIFY_CORRECTION_MESSAGE = mod.CLARIFY_CORRECTION_MESSAGE
  blueprintServiceSingleton = require('../blueprint.service').blueprintService
  clarifyQuestionKey = require('../../../shared/blueprint-clarify-parsers').clarifyQuestionKey
  loaded = true
} catch (err) {
  console.log('⚠ blueprint-spec.service.ts load failed — tests will be skipped.')
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const FINDINGS_BLOCK = `\`\`\`blueprint-clarify-findings
{"findings":[{"id":"f1","category":"conflicting_requirements","severity":"critical","status":"outstanding","title":"Scope list does not map onto FR numbering","description":"D","specRefs":["Section 6.1"],"recommendation":"R"}],"summary":"1 critical outstanding"}
\`\`\``

const QUESTIONS_BLOCK = `\`\`\`blueprint-clarify-questions
{"questions":[{"id":"q1","header":"Recipient Set","question":"Which recipients should receive the rejection email?","multiSelect":false,"options":[{"label":"Creator + rejector + Accounting DL","recommended":true,"recommendedReason":"Matches the ticket's stated driver"},{"label":"Creator only","recommended":false}]}]}
\`\`\``

const FINDINGS_AND_QUESTIONS = `Found one blocking ambiguity.\n\n${FINDINGS_BLOCK}\n\n${QUESTIONS_BLOCK}`

/** Patch the blueprintService singleton so turn-end can drive a machine. */
function withStubbedBlueprintService(): { transitions: string[]; restore: () => void } {
  const transitions: string[] = []
  const machine = {
    currentState: 'phase-running',
    transition: (event: string) => {
      transitions.push(event)
      return true
    }
  }
  const origGetMachine = blueprintServiceSingleton.getMachine
  const origSetClarifyState = blueprintServiceSingleton.setClarifyState
  blueprintServiceSingleton.getMachine = () => machine
  blueprintServiceSingleton.setClarifyState = () => {}
  return {
    transitions,
    restore: () => {
      blueprintServiceSingleton.getMachine = origGetMachine
      blueprintServiceSingleton.setClarifyState = origSetClarifyState
    }
  }
}

/** Collect the clarify events a turn emits. */
function recordEvents(service: any): string[] {
  const events: string[] = []
  for (const name of ['clarifyQuestions', 'clarifyAwaitingInput', 'clarifyFindings', 'clarifyGateReady']) {
    service.on(name, () => events.push(name))
  }
  return events
}

if (loaded) {
  describe('clarify turn-end — re-surfacing unanswered questions', () => {
    test('a verbatim re-emission of UNANSWERED questions shows the cards again', async () => {
      const stub = withStubbedBlueprintService()
      try {
        const service = new BlueprintSpecService()
        const events = recordEvents(service)

        // Round 1 — questions asked for the first time.
        await service.handleClarifyTurnEnd('bp-1', 'ws-1', FINDINGS_AND_QUESTIONS)
        assert.ok(events.includes('clarifyQuestions'), 'round 1 must emit question cards')

        // User never answered; they typed "provide the questions again" and the
        // model re-emitted the identical block.
        events.length = 0
        await service.handleClarifyTurnEnd('bp-1', 'ws-1', FINDINGS_AND_QUESTIONS)

        assert.ok(
          events.includes('clarifyQuestions'),
          'unanswered questions must re-surface as cards, not collapse to free text'
        )
        assert.ok(
          !events.includes('clarifyAwaitingInput'),
          'the free-text fallback must not be used while questions are outstanding'
        )
      } finally {
        stub.restore()
      }
    })

    test('questions the user already ANSWERED are still deduped away', async () => {
      const stub = withStubbedBlueprintService()
      try {
        const service = new BlueprintSpecService()
        const events = recordEvents(service)

        await service.handleClarifyTurnEnd('bp-1', 'ws-1', FINDINGS_AND_QUESTIONS)
        // The user answers — this is what sendClarifyAnswer records.
        service.markPendingAnswered('bp-1')

        events.length = 0
        await service.handleClarifyTurnEnd('bp-1', 'ws-1', FINDINGS_AND_QUESTIONS)

        assert.ok(
          !events.includes('clarifyQuestions'),
          're-asking an answered question must not re-open the card'
        )
      } finally {
        stub.restore()
      }
    })

    test('markPendingAnswered records the on-screen questions exactly once', () => {
      const service = new BlueprintSpecService()
      service.clarifyUiState.set('bp-1', {
        questions: { questions: [{ id: 'q1', header: 'H', question: 'Q?', multiSelect: false, options: [] }] },
        awaitingInput: false
      })

      service.markPendingAnswered('bp-1')
      service.markPendingAnswered('bp-1')

      const answered = service.answeredQuestions.get('bp-1')
      assert.equal(answered.length, 1, 'double submit must not duplicate the ledger entry')
      assert.equal(clarifyQuestionKey(answered[0]), 'q1::Q?')
    })

    test('a free-text answer with no pending cards records nothing', () => {
      const service = new BlueprintSpecService()
      service.markPendingAnswered('bp-1')
      assert.equal(service.answeredQuestions.get('bp-1'), undefined)
    })
  })

  describe('clarify turn-end — findings-only turns get nudged', () => {
    /** Minimal session double that captures the nudge and replays a retry. */
    function installSession(service: any, retryText: string): string[] {
      const sent: string[] = []
      service.clarifySessions.set('bp-1', {
        session: {
          send: async (msg: string) => {
            sent.push(msg)
          },
          getStreamedContent: () => retryText
        },
        conversationId: 'conv-1',
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        activeWatchdog: null
      })
      return sent
    }

    test('findings without questions or completion triggers the corrective nudge', async () => {
      const stub = withStubbedBlueprintService()
      try {
        const service = new BlueprintSpecService()
        const events = recordEvents(service)
        // The nudge succeeds and the model comes back with a proper questions block.
        const sent = installSession(service, FINDINGS_AND_QUESTIONS)

        await service.handleClarifyTurnEnd('bp-1', 'ws-1', `Analysis done.\n\n${FINDINGS_BLOCK}`)

        assert.equal(sent.length, 1, 'a findings-only turn must be nudged exactly once')
        assert.equal(sent[0], CLARIFY_CORRECTION_MESSAGE)
        assert.ok(
          events.includes('clarifyQuestions'),
          'the nudge retry should recover the question cards'
        )
      } finally {
        stub.restore()
      }
    })

    test('the nudge is capped at one attempt and then falls back to free text', async () => {
      const stub = withStubbedBlueprintService()
      try {
        const service = new BlueprintSpecService()
        const events = recordEvents(service)
        // The model repeats a findings-only turn even after being corrected.
        const sent = installSession(service, `${FINDINGS_BLOCK}`)

        await service.handleClarifyTurnEnd('bp-1', 'ws-1', `${FINDINGS_BLOCK}`)

        assert.equal(sent.length, 1, 'the retry must not loop')
        assert.ok(
          events.includes('clarifyAwaitingInput'),
          'after the cap the free-text panel is the escape hatch'
        )
      } finally {
        stub.restore()
      }
    })

    test('a turn that already carries questions is never nudged', async () => {
      const stub = withStubbedBlueprintService()
      try {
        const service = new BlueprintSpecService()
        const sent = installSession(service, '')

        await service.handleClarifyTurnEnd('bp-1', 'ws-1', FINDINGS_AND_QUESTIONS)

        assert.equal(sent.length, 0, 'a compliant turn must not be corrected')
      } finally {
        stub.restore()
      }
    })
  })
}

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('blueprint-clarify-resurface')) {
  void summaryAsync()
}

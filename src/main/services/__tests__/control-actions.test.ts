/**
 * Tests for control-actions MCP tool — schema validation, mode-based availability,
 * and callback invocation.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { planSchema, askUserSchema, emitMemorySchema } from '../control-actions.tool'
import type { ControlActionCallbacks } from '../control-actions.tool'

// -- Schema validation tests --

describe('planSchema', () => {
  test('accepts minimal plan', () => {
    const result = planSchema.parse({ title: 'Test', summary: 'A plan' })
    assert.equal(result.title, 'Test')
    assert.equal(result.summary, 'A plan')
  })

  test('accepts full plan with all optional fields', () => {
    const result = planSchema.parse({
      title: 'Refactor auth',
      summary: 'Extract auth logic',
      problemSummary: 'Auth is scattered',
      rootCause: 'No single auth module',
      decisions: [{ what: 'Use middleware', why: 'Centralized' }],
      sections: [
        {
          heading: 'Phase 1',
          content: 'Create auth module in `src/auth.ts`'
        }
      ],
      files: ['src/auth.ts'],
      risks: [{ risk: 'Breaking change', severity: 'medium' }],
      expectedOutcome: 'Clean auth layer',
      deferredItems: ['Phase 2 migration']
    })
    assert.equal(result.title, 'Refactor auth')
    assert.equal(result.risks?.[0].severity, 'medium')
  })

  test('accepts plan with diagrams', () => {
    const result = planSchema.parse({
      title: 'Arch plan',
      summary: 'Architecture redesign',
      diagrams: [{ title: 'Flow', mermaid: 'flowchart LR\nA-->B' }]
    })
    assert.equal(result.diagrams?.length, 1)
    assert.equal(result.diagrams?.[0].title, 'Flow')
  })

  test('accepts plan with filesChanged', () => {
    const result = planSchema.parse({
      title: 'Fix',
      summary: 'Quick fix',
      filesChanged: [{ file: 'src/index.ts', change: 'Add import' }]
    })
    assert.equal(result.filesChanged?.length, 1)
  })

  test('rejects plan without title', () => {
    assert.throws(() => planSchema.parse({ summary: 'No title' }))
  })

  test('rejects plan without summary', () => {
    assert.throws(() => planSchema.parse({ title: 'No summary' }))
  })

  test('rejects invalid risk severity', () => {
    assert.throws(() =>
      planSchema.parse({
        title: 'Bad',
        summary: 'Bad',
        risks: [{ risk: 'x', severity: 'extreme' }]
      })
    )
  })
})

describe('askUserSchema', () => {
  test('accepts single question', () => {
    const result = askUserSchema.parse({
      questions: [{ question: 'Which approach?' }]
    })
    assert.equal(result.questions.length, 1)
  })

  test('accepts question with options', () => {
    const result = askUserSchema.parse({
      questions: [
        {
          question: 'Which DB?',
          header: 'Database',
          options: [
            { label: 'PostgreSQL', description: 'Full-featured' },
            { label: 'SQLite', description: 'Lightweight' }
          ]
        }
      ]
    })
    assert.equal(result.questions[0].options?.length, 2)
  })

  test('accepts multiple questions', () => {
    const result = askUserSchema.parse({
      questions: [{ question: 'Q1' }, { question: 'Q2', header: 'Section' }, { question: 'Q3' }]
    })
    assert.equal(result.questions.length, 3)
  })

  test('accepts empty questions array', () => {
    const result = askUserSchema.parse({ questions: [] })
    assert.equal(result.questions.length, 0)
  })

  test('rejects missing question field', () => {
    assert.throws(() => askUserSchema.parse({ questions: [{ header: 'No question' }] }))
  })
})

describe('emitMemorySchema', () => {
  test('accepts valid memory', () => {
    const result = emitMemorySchema.parse({
      type: 'user',
      title: 'Prefers dark mode',
      content: 'User explicitly stated they prefer dark mode for all UI work'
    })
    assert.equal(result.type, 'user')
    assert.equal(result.title, 'Prefers dark mode')
  })

  test('accepts all valid memory types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
      const result = emitMemorySchema.parse({ type, title: `${type} memory`, content: 'content' })
      assert.equal(result.type, type)
    }
  })

  test('rejects invalid memory type', () => {
    assert.throws(() =>
      emitMemorySchema.parse({ type: 'invalid', title: 'Bad', content: 'content' })
    )
  })

  test('rejects empty title', () => {
    assert.throws(() => emitMemorySchema.parse({ type: 'user', title: '', content: 'content' }))
  })

  test('rejects empty content', () => {
    assert.throws(() => emitMemorySchema.parse({ type: 'user', title: 'Title', content: '' }))
  })

  test('rejects missing fields', () => {
    assert.throws(() => emitMemorySchema.parse({ type: 'user' }))
    assert.throws(() => emitMemorySchema.parse({ title: 'x', content: 'y' }))
  })
})

// -- Callback invocation tests --

describe('Control action callbacks', () => {
  test('onPlan callback receives StructuredPlan-shaped data', () => {
    let receivedPlan: unknown = null
    const callbacks: ControlActionCallbacks = {
      onPlan: (plan) => {
        receivedPlan = plan
      },
      onAskUser: () => {},
      onMemory: () => {}
    }
    const plan = planSchema.parse({ title: 'Test Plan', summary: 'Plan summary' })
    callbacks.onPlan(plan as Parameters<ControlActionCallbacks['onPlan']>[0])
    assert.ok(receivedPlan)
    assert.equal((receivedPlan as Record<string, unknown>).title, 'Test Plan')
    assert.equal((receivedPlan as Record<string, unknown>).summary, 'Plan summary')
  })

  test('onAskUser callback receives question array and requestId', () => {
    let receivedQuestions: unknown = null
    let receivedRequestId: string | undefined
    const callbacks: ControlActionCallbacks = {
      onPlan: () => {},
      onAskUser: (questions, _action, requestId) => {
        receivedQuestions = questions
        receivedRequestId = requestId
      },
      onMemory: () => {}
    }
    const { questions } = askUserSchema.parse({
      questions: [{ question: 'Which approach?' }]
    })
    callbacks.onAskUser(
      questions as Parameters<ControlActionCallbacks['onAskUser']>[0],
      undefined,
      'req-123'
    )
    assert.ok(receivedQuestions)
    assert.equal((receivedQuestions as Array<unknown>).length, 1)
    assert.equal(receivedRequestId, 'req-123')
  })

  test('onMemory callback receives memory data', () => {
    let receivedMemory: unknown = null
    const callbacks: ControlActionCallbacks = {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: (memory) => {
        receivedMemory = memory
      }
    }
    const memory = emitMemorySchema.parse({
      type: 'feedback',
      title: 'Use kebab-case',
      content: 'User corrected: always use kebab-case for file names'
    })
    callbacks.onMemory(memory)
    assert.ok(receivedMemory)
    assert.equal((receivedMemory as Record<string, unknown>).type, 'feedback')
    assert.equal((receivedMemory as Record<string, unknown>).title, 'Use kebab-case')
  })
})

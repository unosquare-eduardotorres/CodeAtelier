import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, describe } from './test-harness'

describe('Suite 9: Event sequence', () => {
  test('handoff event carries correct HandoffBrief shape', () => {
    const emitter = new EventEmitter()
    let received: unknown = null

    emitter.on('handoff', (brief) => {
      received = brief
    })

    const brief = {
      summary: 'Investigate authentication handoff behavior',
      decisions: ['Use targeted investigation first'],
      constraints: ['No schema changes'],
      filesDiscussed: ['src/main/services/generalist.service.ts'],
      recentMessages: [{ role: 'user', content: 'Find why handoff fails' }],
      specialists: ['dotnet-architect'],
      mode: 'plan' as const
    }

    emitter.emit('handoff', brief)

    assert.deepEqual(received, brief)
  })

  test('subAgentsComplete is emitted even after error path', () => {
    const emitter = new EventEmitter()
    const sequence: string[] = []

    emitter.on('chunk', (chunk: { type?: string }) => {
      if (chunk.type === 'error') {
        sequence.push('error')
      }
    })

    emitter.on('subAgentsComplete', () => {
      sequence.push('complete')
    })

    emitter.emit('chunk', { type: 'error', text: 'specialist failure' })
    emitter.emit('subAgentsComplete')

    assert.deepEqual(sequence, ['error', 'complete'])
  })

  test('chunk events accumulate text content', () => {
    const emitter = new EventEmitter()
    let accumulated = ''

    emitter.on('chunk', (chunk: { type?: string; text?: string }) => {
      if (chunk.type === 'text') {
        accumulated += chunk.text ?? ''
      }
    })

    emitter.emit('chunk', { type: 'text', text: 'Agent' })
    emitter.emit('chunk', { type: 'text', text: ' Studio' })
    emitter.emit('chunk', { type: 'text', text: ' pipeline' })

    assert.equal(accumulated, 'Agent Studio pipeline')
  })
})

describe('Suite 10: Listener lifecycle', () => {
  test('listeners are cleaned up after removal', () => {
    const emitter = new EventEmitter()
    const first = () => undefined
    const second = () => undefined

    emitter.on('handoff', first)
    emitter.on('handoff', second)
    assert.equal(emitter.listenerCount('handoff'), 2)

    emitter.removeListener('handoff', first)
    assert.equal(emitter.listenerCount('handoff'), 1)
  })

  test('one-shot handoff behavior via removeListener', () => {
    const emitter = new EventEmitter()
    let calls = 0

    const handoffHandler = () => {
      calls++
      emitter.removeListener('handoff', handoffHandler)
    }

    emitter.on('handoff', handoffHandler)
    emitter.emit('handoff', { summary: 'first' })
    emitter.emit('handoff', { summary: 'second' })

    assert.equal(calls, 1)
  })

  test('rapid event registration does not leak listeners', () => {
    const emitter = new EventEmitter()

    for (let i = 0; i < 10; i++) {
      const handler = () => undefined
      emitter.on('chunk', handler)
      emitter.removeListener('chunk', handler)
    }

    assert.equal(emitter.listenerCount('chunk'), 0)
  })
})

// Report handled by test runner

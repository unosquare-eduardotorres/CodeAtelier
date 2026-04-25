import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, describe } from './test-harness'

/**
 * EventEmitter lifecycle patterns used by AgentSessionService + ChatStreamService.
 */
describe('Suite 9: Event sequence', () => {
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

    emitter.on('complete', first)
    emitter.on('complete', second)
    assert.equal(emitter.listenerCount('complete'), 2)

    emitter.removeListener('complete', first)
    assert.equal(emitter.listenerCount('complete'), 1)
  })

  test('one-shot behavior via removeListener', () => {
    const emitter = new EventEmitter()
    let calls = 0

    const handler = () => {
      calls++
      emitter.removeListener('intent', handler)
    }

    emitter.on('intent', handler)
    emitter.emit('intent', { type: 'first' })
    emitter.emit('intent', { type: 'second' })

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

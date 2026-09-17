/**
 * STREAM-COMPLETE-DRAIN: stream completion must see every chunk sent before it.
 *
 * Chunks reach the store through ChunkConsumer's rAF queue; completion does not.
 * On 2026-09-16 a plan turn finished while frames were starved (avg ACK latency
 * 8118ms), so completion finalized "…Fix the bro" and the queued "ken references."
 * later opened a second bubble stuck on "writing…" with no completion to end it.
 *
 * The renderer here is a minimal model of chat.store's streaming buffer, driven
 * in the same order useAppIpcListeners wires the IPC events.
 *
 * Run: tsx src/renderer/src/hooks/__tests__/chunk-consumer-drain.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { ChunkConsumer, type ChunkData } from '../useChunkConsumer'

// ── Starved frames: rAF callbacks are held until the test runs them ──────────
let nextFrameId = 1
const frames = new Map<number, () => void>()
const acks: Array<{ processed: number; perConversation: Record<string, number> }> = []

// Both runners import every test into one process — restore globals when done.
const g = globalThis as Record<string, unknown>
const originals = {
  requestAnimationFrame: g.requestAnimationFrame,
  cancelAnimationFrame: g.cancelAnimationFrame,
  window: g.window
}
g.requestAnimationFrame = (cb: () => void): number => {
  const id = nextFrameId++
  frames.set(id, cb)
  return id
}
g.cancelAnimationFrame = (id: number): void => {
  frames.delete(id)
}
g.window = {
  api: {
    chunkAck: (ack: { processed: number; perConversation: Record<string, number> }) =>
      acks.push(ack)
  }
}

function runFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const cb of pending) cb()
}

// ── Minimal renderer model ───────────────────────────────────────────────────
interface Renderer {
  streaming: boolean
  buffer: string
  messages: string[]
}

function createRenderer(): { renderer: Renderer; consumer: ChunkConsumer; complete: () => void } {
  const renderer: Renderer = { streaming: false, buffer: '', messages: [] }
  const consumer = new ChunkConsumer((batch) => {
    for (const data of batch) {
      renderer.streaming = true
      renderer.buffer += data.chunk ?? ''
    }
  })
  const complete = (): void => {
    // Mirrors useAppIpcListeners' onMessageComplete wiring.
    consumer.drain()
    renderer.messages.push(renderer.buffer)
    renderer.buffer = ''
    renderer.streaming = false
  }
  return { renderer, consumer, complete }
}

const chunk = (text: string): ChunkData => ({ conversationId: 'conv-46ee', chunk: text })

function reset(): void {
  frames.clear()
  acks.length = 0
}

describe('ChunkConsumer.drain', () => {
  test('completion during starved frames finalizes the whole message', () => {
    reset()
    const { renderer, consumer, complete } = createRenderer()

    consumer.push(chunk('1. Fix the bro'))
    runFrames()
    consumer.push(chunk('ken references.\n'))
    consumer.push(chunk('2. Rename code names.'))
    // Frames starved: completion arrives before the queued chunks are processed.
    complete()

    assert.deepEqual(renderer.messages, ['1. Fix the broken references.\n2. Rename code names.'])
    assert.equal(renderer.streaming, false)

    // The frame that was pending when completion arrived must not reopen a bubble.
    runFrames()
    assert.equal(renderer.streaming, false, 'no streaming bubble may outlive completion')
    assert.equal(renderer.buffer, '')
    assert.equal(renderer.messages.length, 1)
  })

  test('drained chunks are ACKed so main releases backpressure', () => {
    reset()
    const { consumer } = createRenderer()

    consumer.push(chunk('a'))
    consumer.push(chunk('b'))
    consumer.drain()

    assert.equal(acks.length, 1)
    assert.equal(acks[0].processed, 2)
    assert.deepEqual(acks[0].perConversation, { 'conv-46ee': 2 })
  })

  test('drain cancels the pending frame instead of leaving it to fire', () => {
    reset()
    const { consumer } = createRenderer()

    consumer.push(chunk('a'))
    assert.equal(frames.size, 1)
    consumer.drain()
    assert.equal(frames.size, 0)

    // A later push must schedule a fresh frame, not assume one is pending.
    consumer.push(chunk('b'))
    assert.equal(frames.size, 1)
  })

  test('drain with an empty queue does nothing', () => {
    reset()
    let calls = 0
    const consumer = new ChunkConsumer(() => calls++)

    consumer.drain()

    assert.equal(calls, 0)
    assert.equal(acks.length, 0)
  })
})

for (const [key, value] of Object.entries(originals)) {
  if (value === undefined) delete g[key]
  else g[key] = value
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

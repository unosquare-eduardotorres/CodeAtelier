/**
 * Integration test: verify onnxruntime-web works in a Node.js environment.
 *
 * This validates the WASM backend before we patch @huggingface/transformers
 * to use onnxruntime-web instead of the native onnxruntime-node (which crashes
 * in Electron due to BFCArena::Extend → operator new on first inference).
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

describe('onnxruntime-web in Node.js', () => {
  test('InferenceSession is available', async () => {
    const { InferenceSession } = await import('onnxruntime-web')
    assert.equal(typeof InferenceSession.create, 'function')
  })

  test('env.wasm is configurable', async () => {
    const { env } = await import('onnxruntime-web')
    assert.equal(typeof env.wasm, 'object')
    env.wasm.numThreads = 1 // Should not throw
  })

  test('Tensor creation works', async () => {
    const { Tensor } = await import('onnxruntime-web')
    const t = new Tensor('float32', [1.0, 2.0, 3.0], [3])
    assert.equal(t.dims[0], 3)
    assert.equal(t.type, 'float32')
  })
})

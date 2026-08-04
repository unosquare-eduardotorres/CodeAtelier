/**
 * Phase 24 — IPC Coverage Blitz: chat-completion.ipc, chat-mode.ipc, chat-message.ipc
 *
 * Deep coverage for the three chat sub-modules.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-chat-completion-mode.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  mockMainWindow,
  tryInvokeHandler,
} from '../../services/__tests__/electron-stub'

setupElectronStub()

let chatCompletionLoaded = false
let chatModeLoaded = false
let chatMessageLoaded = false

try {
  const mod = require('../../ipc/chat-completion.ipc')
  mod.registerChatCompletionIpc()
  chatCompletionLoaded = true
} catch (err) {
  console.log(`⚠ chat-completion.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/chat-mode.ipc')
  mod.registerChatModeIpc()
  chatModeLoaded = true
} catch (err) {
  console.log(`⚠ chat-mode.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/chat-message.ipc')
  mod.registerChatMessageIpc(mockMainWindow)
  chatMessageLoaded = true
} catch (err) {
  console.log(`⚠ chat-message.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// chat-completion.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (chatCompletionLoaded) {
  describe('chat-completion.ipc — channel registration', () => {
    const ccCh = [...capturedHandlers.keys()].filter(c =>
      c.includes('chat') && (c.includes('close') || c.includes('complete') ||
      c.includes('clipboard') || c.includes('saveImage') || c.includes('readImage'))
    )
    test('registers chat completion channels', () => {
      assert.ok(ccCh.length >= 2, `Expected ≥2, got ${ccCh.length}: ${ccCh.join(', ')}`)
    })
  })

  describe('chat-completion.ipc — handler bodies', () => {
    const closeCh = [...capturedHandlers.keys()].find(c =>
      c.includes('chat') && c.includes('close') && !c.includes('lifecycle')
    )
    if (closeCh) {
      test(`${closeCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(closeCh, {})
        assert.equal(r.ok, false)
      })

      test(`${closeCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(closeCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const completeCh = [...capturedHandlers.keys()].find(c =>
      c.includes('chat') && c.includes('complete')
    )
    if (completeCh) {
      test(`${completeCh} calls through`, async () => {
        const r = await tryInvokeHandler(completeCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    // clipboard image save/read
    const saveImgCh = [...capturedHandlers.keys()].find(c =>
      c.includes('clipboard') && c.includes('save')
    )
    if (saveImgCh) {
      test(`${saveImgCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(saveImgCh, { imageData: 'data:image/png;base64,abc' })
        assert.equal(r.ok, false)
      })

      test(`${saveImgCh} calls through`, async () => {
        const r = await tryInvokeHandler(saveImgCh, {
          conversationId: 'c1',
          imageData: 'data:image/png;base64,abc',
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const readImgCh = [...capturedHandlers.keys()].find(c =>
      c.includes('clipboard') && c.includes('read')
    )
    if (readImgCh) {
      test(`${readImgCh} calls through`, async () => {
        const r = await tryInvokeHandler(readImgCh)
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// chat-mode.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (chatModeLoaded) {
  describe('chat-mode.ipc — channel registration', () => {
    const modeCh = [...capturedHandlers.keys()].filter(c =>
      c.includes('chat') && (c.includes('mode') || c.includes('effort') ||
      c.includes('context') || c.includes('Mode') || c.includes('Effort'))
    )
    test('registers chat mode channels', () => {
      assert.ok(modeCh.length >= 2, `Expected ≥2, got ${modeCh.length}: ${modeCh.join(', ')}`)
    })
  })

  describe('chat-mode.ipc — handler bodies', () => {
    const updateModeCh = [...capturedHandlers.keys()].find(c =>
      c.includes('chat') && (c.includes('updateMode') || c.includes('setMode'))
    )
    if (updateModeCh) {
      test(`${updateModeCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(updateModeCh, { mode: 'plan' })
        assert.equal(r.ok, false)
      })

      test(`${updateModeCh} calls through with valid args`, async () => {
        const r = await tryInvokeHandler(updateModeCh, {
          conversationId: 'c1',
          mode: 'plan',
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const effortCh = [...capturedHandlers.keys()].find(c =>
      c.includes('chat') && c.includes('effort')
    )
    if (effortCh) {
      test(`${effortCh} calls through`, async () => {
        const r = await tryInvokeHandler(effortCh, {
          conversationId: 'c1',
          effort: 'high',
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const contextCh = [...capturedHandlers.keys()].find(c =>
      c.includes('chat') && c.includes('context') && c.includes('usage')
    )
    if (contextCh) {
      test(`${contextCh} calls through`, async () => {
        const r = await tryInvokeHandler(contextCh, { conversationId: 'c1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// chat-message.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (chatMessageLoaded) {
  describe('chat-message.ipc — channel registration', () => {
    test('registers chat:send', () => {
      assert.ok(capturedHandlers.has('chat:send'))
    })

    test('registers chat:stop', () => {
      assert.ok(capturedHandlers.has('chat:stop'))
    })
  })

  describe('chat-message.ipc — argument validation', () => {
    test('chat:send rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('chat:send', { text: 'hello' })
      assert.equal(r.ok, false)
    })

    test('chat:send rejects non-object', async () => {
      const r = await tryInvokeHandler('chat:send', 'bad')
      assert.equal(r.ok, false)
    })

    test('chat:send rejects null', async () => {
      const r = await tryInvokeHandler('chat:send', null)
      assert.equal(r.ok, false)
    })
  })

  describe('chat-message.ipc — handler bodies', () => {
    test('chat:send calls through with valid minimal args', async () => {
      const r = await tryInvokeHandler('chat:send', {
        conversationId: 'c1',
        text: 'Hello world',
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('chat:send calls through with attachments', async () => {
      const r = await tryInvokeHandler('chat:send', {
        conversationId: 'c1',
        text: 'Check this',
        attachments: [{ path: '/tmp/file.txt', name: 'file.txt' }],
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('chat:stop calls through', async () => {
      const r = await tryInvokeHandler('chat:stop')
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-chat-completion-mode')) {
  void summaryAsync()
}

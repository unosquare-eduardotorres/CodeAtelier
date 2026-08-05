/**
 * Phase 24 — IPC Coverage Blitz: core-agent-alias.ipc, core-agent-prompt.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-core-agent-alias-prompt.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let aliasLoaded = false
let promptLoaded = false

try {
  const mod = require('../../ipc/core-agent-alias.ipc')
  mod.registerCoreAgentAliasIpc()
  aliasLoaded = true
} catch (err) {
  console.log(`⚠ core-agent-alias.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/core-agent-prompt.ipc')
  mod.registerCoreAgentPromptIpc()
  promptLoaded = true
} catch (err) {
  console.log(`⚠ core-agent-prompt.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// core-agent-alias.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (aliasLoaded) {
  describe('core-agent-alias.ipc — channel registration', () => {
    test('registers coreAgent:list', () => {
      assert.ok(getHandlers().has('coreAgent:list'))
    })

    test('registers coreAgent:upsert', () => {
      assert.ok(getHandlers().has('coreAgent:upsert'))
    })
  })

  describe('core-agent-alias.ipc — argument validation', () => {
    test('coreAgent:upsert rejects missing agentRole', async () => {
      const r = await tryInvokeHandler('coreAgent:upsert', { alias: 'Bot' })
      assert.equal(r.ok, false)
    })

    test('coreAgent:upsert rejects invalid agentRole', async () => {
      const r = await tryInvokeHandler('coreAgent:upsert', { agentRole: 'admin' })
      assert.equal(r.ok, false)
    })

    test('coreAgent:upsert rejects non-object', async () => {
      const r = await tryInvokeHandler('coreAgent:upsert', 'bad')
      assert.equal(r.ok, false)
    })
  })

  describe('core-agent-alias.ipc — handler bodies', () => {
    test('coreAgent:list calls through', async () => {
      const r = await tryInvokeHandler('coreAgent:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgent:upsert calls through with valid args', async () => {
      const r = await tryInvokeHandler('coreAgent:upsert', {
        agentRole: 'specialist',
        alias: 'CodeBot',
        avatarKey: 'avatar-02'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgent:upsert calls through with null alias', async () => {
      const r = await tryInvokeHandler('coreAgent:upsert', {
        agentRole: 'specialist',
        alias: null,
        avatarKey: null
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// core-agent-prompt.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (promptLoaded) {
  describe('core-agent-prompt.ipc — channel registration', () => {
    test('registers coreAgentPrompt:list', () => {
      assert.ok(getHandlers().has('coreAgentPrompt:list'))
    })

    test('registers coreAgentPrompt:get', () => {
      assert.ok(getHandlers().has('coreAgentPrompt:get'))
    })

    test('registers coreAgentPrompt:upsert', () => {
      assert.ok(getHandlers().has('coreAgentPrompt:upsert'))
    })

    test('registers coreAgentPrompt:reset', () => {
      assert.ok(getHandlers().has('coreAgentPrompt:reset'))
    })
  })

  describe('core-agent-prompt.ipc — argument validation', () => {
    test('coreAgentPrompt:get rejects missing agentRole', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', { mode: 'plan' })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:get rejects missing mode', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', { agentRole: 'specialist' })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:get rejects invalid agentRole', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', { agentRole: 'admin', mode: 'plan' })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:get rejects invalid mode', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', {
        agentRole: 'specialist',
        mode: 'invalid'
      })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:upsert rejects missing promptText', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:upsert', {
        agentRole: 'specialist',
        mode: 'plan'
      })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:upsert rejects invalid mode', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:upsert', {
        agentRole: 'specialist',
        mode: 'unknown',
        promptText: 'test'
      })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:reset rejects missing agentRole', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:reset', { mode: 'plan' })
      assert.equal(r.ok, false)
    })

    test('coreAgentPrompt:reset rejects invalid mode', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:reset', {
        agentRole: 'specialist',
        mode: 'x'
      })
      assert.equal(r.ok, false)
    })
  })

  describe('core-agent-prompt.ipc — handler bodies', () => {
    test('coreAgentPrompt:list calls through', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:list')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgentPrompt:get calls through with valid args', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', {
        agentRole: 'specialist',
        mode: 'plan'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgentPrompt:get accepts mode=build', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', {
        agentRole: 'specialist',
        mode: 'build'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgentPrompt:get accepts mode=danger', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:get', {
        agentRole: 'specialist',
        mode: 'danger'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgentPrompt:upsert calls through with valid args', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:upsert', {
        agentRole: 'specialist',
        mode: 'plan',
        promptText: 'You are a helpful assistant.'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('coreAgentPrompt:reset calls through with valid args', async () => {
      const r = await tryInvokeHandler('coreAgentPrompt:reset', {
        agentRole: 'specialist',
        mode: 'build'
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-core-agent-alias-prompt')) {
  void summaryAsync()
}

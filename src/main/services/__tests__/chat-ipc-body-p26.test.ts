/**
 * Phase 26 — chat-completion.ipc.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { describe, test, beforeEach } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  mockMainWindow,
  getHandlers,
  tryInvokeHandler,
  sentEvents
} from './setup-full-mock'

setupFullMock()

const convoRepo = getMockRepo('conversation')
const wsRepo = getMockRepo('workspace')

const mod = require('../../ipc/chat-completion.ipc')
const registerFn = mod.registerChatCompletionIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('chat-completion.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers chat handlers', () => {
    const handlers = getHandlers()
    const chatHandlers = [...handlers.keys()].filter(
      (k) => k.includes('chat:') || k.includes('stream:')
    )
    assert.ok(chatHandlers.length > 0)
  })

  test('chat:send invokes stream service', async () => {
    convoRepo.findById.mockReturnValue({ id: 'conv-1', workspaceId: 'ws-1' })
    wsRepo.findById.mockReturnValue({ id: 'ws-1', path: '/tmp/test' })
    const r = await tryInvokeHandler('chat:send', {
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      message: 'Hello AI'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('chat:stop stops active stream', async () => {
    const r = await tryInvokeHandler('chat:stop', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('chat:compact compacts conversation', async () => {
    const r = await tryInvokeHandler('chat:compact', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── dialog:readImageBase64 path authorisation ─────────────────────────────

  const userData = (require('electron') as typeof import('electron')).app.getPath('userData')

  /** True when the handler rejected the path before ever touching the filesystem. */
  async function wasAccessDenied(filePath: string): Promise<boolean> {
    const r = await tryInvokeHandler('dialog:readImageBase64', { filePath })
    return !r.ok && r.error.message.includes('Access denied')
  }

  test('readImageBase64 allows paths under chat-images', async () => {
    const p = join(userData, 'chat-images', 'conv-1', 'clipboard-1.png')
    assert.equal(await wasAccessDenied(p), false)
  })

  test('readImageBase64 allows paths under blueprint-docs', async () => {
    const p = join(userData, 'blueprint-docs', 'ws-1', 'bp-1', 'attachment.png')
    assert.equal(await wasAccessDenied(p), false)
  })

  test('readImageBase64 denies sibling dir with allowed-root prefix', async () => {
    const p = join(userData, 'blueprint-docs-evil', 'x.png')
    assert.equal(await wasAccessDenied(p), true)
  })

  test('readImageBase64 denies traversal outside allowed roots', async () => {
    assert.equal(await wasAccessDenied('../../etc/passwd'), true)
  })

  // ─── dialog:stageImageFile / dialog:clearStagedImages ──────────────────

  const chatImagesRoot = join(userData, 'chat-images')

  /** Write a throwaway source file outside every allowed root. */
  function makeSourceFile(name: string): string {
    const dir = join(userData, 'stage-src')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, name)
    writeFileSync(p, 'not-really-an-image')
    return p
  }

  /** Error message from a handler that was expected to reject. */
  async function rejection(channel: string, args: unknown): Promise<string> {
    const r = await tryInvokeHandler(channel, args)
    if (r.ok) throw new Error(`${channel} unexpectedly succeeded`)
    return r.error.message
  }

  /** Stage an image, failing the test if the handler rejected. */
  async function stage(scope: string, sourcePath: string): Promise<string> {
    const r = await tryInvokeHandler('dialog:stageImageFile', { scope, sourcePath })
    if (!r.ok) throw r.error
    return r.result as string
  }

  test('stageImageFile rejects a non-image extension', async () => {
    const msg = await rejection('dialog:stageImageFile', {
      scope: 'blueprint-draft-1',
      sourcePath: makeSourceFile('notes.pdf')
    })
    assert.match(msg, /not an image/)
  })

  test('stageImageFile rejects a traversal-shaped scope', async () => {
    const msg = await rejection('dialog:stageImageFile', {
      scope: '../../etc',
      sourcePath: makeSourceFile('shot.png')
    })
    assert.match(msg, /invalid scope/)
  })

  test('stageImageFile copies into chat-images/<scope>/ and the result is readable', async () => {
    // Deliberately not a `blueprint-draft-*` name: the sweep test below runs
    // concurrently and would delete the dir out from under this assertion.
    const scope = 'stage-scope-1'
    const staged = await stage(scope, makeSourceFile('shot.png'))
    assert.ok(
      staged.startsWith(join(chatImagesRoot, scope)),
      `staged path should live under the scope dir, got ${staged}`
    )
    assert.ok(existsSync(staged), 'staged file should exist on disk')
    // The whole point: a staged path passes the read authorisation that the
    // original dropped path fails.
    assert.equal(await wasAccessDenied(staged), false)
  })

  test('clearStagedImages removes the scope dir', async () => {
    const scope = 'stage-scope-2'
    await stage(scope, makeSourceFile('shot.png'))
    assert.ok(existsSync(join(chatImagesRoot, scope)), 'scope dir should exist before clearing')

    const r = await tryInvokeHandler('dialog:clearStagedImages', { scope })
    assert.equal(r.ok, true)
    assert.equal(existsSync(join(chatImagesRoot, scope)), false)
  })

  test('clearStagedImages rejects a traversal-shaped scope', async () => {
    const msg = await rejection('dialog:clearStagedImages', { scope: '../../etc' })
    assert.match(msg, /invalid scope/)
  })

  test('boot sweep drops orphaned staging dirs but keeps conversation dirs', () => {
    const orphanDraft = join(chatImagesRoot, 'blueprint-draft-orphan')
    const legacyScope = join(chatImagesRoot, 'blueprint-input')
    const conversation = join(chatImagesRoot, 'a1b2c3d4-0000-4000-8000-000000000000')
    for (const dir of [orphanDraft, legacyScope, conversation]) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
    }

    // Re-registering re-runs the sweep (handlers are captured into a Map).
    registerFn()

    assert.equal(existsSync(orphanDraft), false, 'draft staging dir should be swept')
    assert.equal(existsSync(legacyScope), false, 'legacy blueprint-input dir should be swept')
    assert.equal(existsSync(conversation), true, 'conversation image dir must survive')
  })
})

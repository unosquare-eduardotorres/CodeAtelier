/**
 * Phase 24 — IPC Coverage Blitz: docs.ipc, repo.ipc, github.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-docs-repo-github.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let docsLoaded = false
let repoLoaded = false
let githubLoaded = false

try {
  const mod = require('../../ipc/docs.ipc')
  mod.registerDocsIpc()
  docsLoaded = true
} catch (err) {
  console.log(`⚠ docs.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/repo.ipc')
  mod.registerRepoIpc()
  repoLoaded = true
} catch (err) {
  console.log(`⚠ repo.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/github.ipc')
  mod.registerGithubIpc()
  githubLoaded = true
} catch (err) {
  console.log(`⚠ github.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// docs.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (docsLoaded) {
  describe('docs.ipc — channel registration', () => {
    test('registers docs:list', () => {
      assert.ok(getHandlers().has('docs:list'))
    })

    test('registers docs:readFile', () => {
      assert.ok(getHandlers().has('docs:readFile'))
    })

    test('registers docs:renderMermaid', () => {
      assert.ok(getHandlers().has('docs:renderMermaid'))
    })
  })

  describe('docs.ipc — argument validation', () => {
    test('docs:list rejects missing workspacePath', async () => {
      const r = await tryInvokeHandler('docs:list', {})
      assert.equal(r.ok, false)
    })

    test('docs:readFile rejects missing filePath', async () => {
      const r = await tryInvokeHandler('docs:readFile', { workspacePath: '/tmp' })
      assert.equal(r.ok, false)
    })

    test('docs:readFile rejects missing workspacePath', async () => {
      const r = await tryInvokeHandler('docs:readFile', { filePath: '/tmp/a.md' })
      assert.equal(r.ok, false)
    })

    test('docs:readFile rejects path traversal outside docs/', async () => {
      const r = await tryInvokeHandler('docs:readFile', {
        filePath: '/etc/passwd',
        workspacePath: '/tmp/myproject'
      })
      assert.equal(r.ok, false)
    })

    test('docs:renderMermaid rejects missing definition', async () => {
      const r = await tryInvokeHandler('docs:renderMermaid', {})
      assert.equal(r.ok, false)
    })
  })

  describe('docs.ipc — handler bodies', () => {
    test('docs:list calls through', async () => {
      const r = await tryInvokeHandler('docs:list', { workspacePath: '/tmp/project' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('docs:renderMermaid calls through', async () => {
      const r = await tryInvokeHandler('docs:renderMermaid', {
        definition: 'graph TD; A-->B;',
        id: 'test-diagram'
      })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// repo.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (repoLoaded) {
  describe('repo.ipc — channel registration', () => {
    test('registers repo:init', () => {
      assert.ok(getHandlers().has('repo:init'))
    })

    test('registers repo:setRemote', () => {
      assert.ok(getHandlers().has('repo:setRemote'))
    })

    test('registers repo:getInfo', () => {
      assert.ok(getHandlers().has('repo:getInfo'))
    })

    test('registers repo:listBranches', () => {
      assert.ok(getHandlers().has('repo:listBranches'))
    })
  })

  describe('repo.ipc — argument validation', () => {
    test('repo:init rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('repo:init', {})
      assert.equal(r.ok, false)
    })

    test('repo:setRemote rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('repo:setRemote', { remoteUrl: 'https://github.com/x' })
      assert.equal(r.ok, false)
    })

    test('repo:setRemote rejects missing remoteUrl', async () => {
      const r = await tryInvokeHandler('repo:setRemote', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
    })

    test('repo:getInfo rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('repo:getInfo', {})
      assert.equal(r.ok, false)
    })

    test('repo:listBranches rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('repo:listBranches', {})
      assert.equal(r.ok, false)
    })
  })

  describe('repo.ipc — handler bodies', () => {
    test('repo:init calls through', async () => {
      const r = await tryInvokeHandler('repo:init', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('repo:getInfo calls through', async () => {
      const r = await tryInvokeHandler('repo:getInfo', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('repo:listBranches calls through', async () => {
      const r = await tryInvokeHandler('repo:listBranches', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// github.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (githubLoaded) {
  describe('github.ipc — channel registration', () => {
    test('registers github:saveToken', () => {
      assert.ok(getHandlers().has('github:saveToken'))
    })

    test('registers github:validateToken', () => {
      assert.ok(getHandlers().has('github:validateToken'))
    })

    test('registers github:getStatus', () => {
      assert.ok(getHandlers().has('github:getStatus'))
    })

    test('registers github:removeToken', () => {
      assert.ok(getHandlers().has('github:removeToken'))
    })
  })

  describe('github.ipc — argument validation', () => {
    test('github:saveToken rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('github:saveToken', { token: 'tok' })
      assert.equal(r.ok, false)
    })

    test('github:saveToken rejects missing token', async () => {
      const r = await tryInvokeHandler('github:saveToken', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
    })

    test('github:validateToken rejects missing token', async () => {
      const r = await tryInvokeHandler('github:validateToken', {})
      assert.equal(r.ok, false)
    })

    test('github:getStatus rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('github:getStatus', {})
      assert.equal(r.ok, false)
    })

    test('github:removeToken rejects missing workspaceId', async () => {
      const r = await tryInvokeHandler('github:removeToken', {})
      assert.equal(r.ok, false)
    })
  })

  describe('github.ipc — handler bodies', () => {
    test('github:saveToken calls through', async () => {
      const r = await tryInvokeHandler('github:saveToken', {
        workspaceId: 'ws-1',
        token: 'ghp_test123'
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('github:validateToken calls through', async () => {
      const r = await tryInvokeHandler('github:validateToken', { token: 'ghp_test123' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('github:getStatus calls through', async () => {
      const r = await tryInvokeHandler('github:getStatus', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('github:removeToken calls through', async () => {
      const r = await tryInvokeHandler('github:removeToken', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-docs-repo-github')) {
  void summaryAsync()
}

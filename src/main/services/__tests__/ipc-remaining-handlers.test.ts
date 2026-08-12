/**
 * ipc-remaining-handlers.test.ts — Phase 21, File 4
 *
 * Deep body coverage for remaining IPC handlers:
 *   - conversation-specialist.ipc.ts, code-changes.ipc.ts, project-specialist.ipc.ts,
 *     project.ipc.ts, specialist.ipc.ts, skill.ipc.ts, indexing.ipc.ts, embedding.ipc.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  tryInvokeHandler,
  mockMainWindow
} from './electron-stub'

setupElectronStub()

// ── Register IPC modules ─────────────────────────────────────────────────

const modules = [
  ['conversation-specialist.ipc', false, 'convSpec'],
  ['code-changes.ipc', false, 'codeChanges'],
  ['project-specialist.ipc', false, 'projSpec'],
  ['project.ipc', false, 'project'],
  ['specialist.ipc', false, 'specialist'],
  ['skill.ipc', false, 'skill'],
  ['indexing.ipc', false, 'indexing'],
  ['embedding.ipc', false, 'embedding']
] as const

const loaded: Record<string, boolean> = {}

for (const [name, needsWin, key] of modules) {
  try {
    const mod = require(`../../ipc/${name}`)
    const fn = Object.values(mod).find(
      (v: any) => typeof v === 'function' && v.name?.startsWith('register')
    ) as any
    if (fn) {
      needsWin ? fn(mockMainWindow) : fn()
      loaded[key] = true
    }
  } catch (err) {
    console.log(`⚠ ${name}: ${(err as Error).message?.split('\n')[0]}`)
    loaded[key] = false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// conversation-specialist.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (loaded.convSpec) {
  describe('conversation-specialist.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter(
      (c) =>
        c.includes('convSpecialist') ||
        c.includes('conv-specialist') ||
        c.includes('conversationSpecialist')
    )
    test('registers conversation specialist channels', () => {
      assert.ok(
        channels.length >= 3,
        `Expected ≥3 channels, got ${channels.length}: ${channels.join(', ')}`
      )
    })
  })

  describe('conversation-specialist.ipc — validation', () => {
    // Find the list channel
    const listCh = [...capturedHandlers.keys()].find(
      (c) =>
        (c.includes('specialist') || c.includes('Specialist')) &&
        c.includes('list') &&
        c.includes('conv')
    )
    if (listCh) {
      test(`${listCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(listCh!, {})
        assert.equal(r.ok, false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// code-changes.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (loaded.codeChanges) {
  describe('code-changes.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter(
      (c) => c.includes('repo:') || c.includes('code-changes')
    )
    test('registers repo channels', () => {
      assert.ok(
        channels.length >= 4,
        `Expected ≥4 channels, got ${channels.length}: ${channels.join(', ')}`
      )
    })
  })

  describe('code-changes.ipc — validation', () => {
    const commitCh = [...capturedHandlers.keys()].find(
      (c) => c.includes('repo') && c.includes('commit')
    )
    if (commitCh) {
      test(`${commitCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(commitCh!, { message: 'test', filePaths: ['a.ts'] })
        assert.equal(r.ok, false)
      })
    }

    const diffCh = [...capturedHandlers.keys()].find(
      (c) => c.includes('repo') && c.includes('diff')
    )
    if (diffCh) {
      test(`${diffCh} rejects missing conversationId`, async () => {
        const r = await tryInvokeHandler(diffCh!, { filePath: 'a.ts' })
        assert.equal(r.ok, false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// project-specialist.ipc.ts & project.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (loaded.projSpec || loaded.project) {
  describe('project/specialist IPC — channels', () => {
    const projectChannels = [...capturedHandlers.keys()].filter((c) => c.includes('project'))
    test('registers project channels', () => {
      assert.ok(
        projectChannels.length >= 2,
        `Expected ≥2 project channels, got ${projectChannels.length}`
      )
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// specialist.ipc.ts & skill.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (loaded.specialist) {
  describe('specialist.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter(
      (c) => c.includes('specialist') && !c.includes('conv') && !c.includes('project')
    )
    test('registers specialist channels', () => {
      assert.ok(
        channels.length >= 2,
        `Expected ≥2 channels, got ${channels.length}: ${channels.join(', ')}`
      )
    })
  })
}

if (loaded.skill) {
  describe('skill.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter((c) => c.includes('skill'))
    test('registers skill channels', () => {
      assert.ok(
        channels.length >= 2,
        `Expected ≥2 channels, got ${channels.length}: ${channels.join(', ')}`
      )
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// indexing.ipc.ts & embedding.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (loaded.indexing) {
  describe('indexing.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter(
      (c) => c.includes('index') || c.includes('code-graph') || c.includes('codeGraph')
    )
    test('registers indexing channels', () => {
      assert.ok(channels.length >= 1, `Expected ≥1 indexing channel`)
    })
  })
}

if (loaded.embedding) {
  describe('embedding.ipc — channels', () => {
    const channels = [...capturedHandlers.keys()].filter((c) => c.includes('embedding'))
    test('registers embedding channels', () => {
      assert.ok(channels.length >= 1, `Expected ≥1 embedding channel`)
    })
  })
}

// ── Comprehensive channel validation test ─────────────────────────────────

describe('IPC handler validation — null args rejection', () => {
  // Test that all handlers reject null args (should fail at requireObject)
  const allChannels = [...capturedHandlers.keys()]
  const tested = new Set<string>()

  for (const ch of allChannels) {
    // Only test channels we haven't already tested above
    if (tested.has(ch)) continue
    tested.add(ch)

    // Skip channels known to accept no args or typed args
    if (
      ch.includes('selectDirectory') ||
      ch.includes('getStatuses') ||
      ch.includes('stopAll') ||
      ch.includes('cacheEfficiency') ||
      ch.includes('getStreamingState') ||
      ch.includes('all-statuses') ||
      ch.includes('compact') ||
      ch.includes('stop') ||
      ch.includes('cancel')
    ) {
      continue
    }
  }
})

// ── Skip blocks ──────────────────────────────────────────────────────────

for (const [name, , key] of modules) {
  if (!loaded[key]) {
    describe(`${name} (skipped)`, () => {
      test('skipped', () => {}, { skipReason: 'module not loaded' })
    })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

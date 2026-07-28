/**
 * Unit tests for chat-agent.service.ts workspace-scoped accessors.
 *
 * Complements chat-stream-role-tagging.test.ts (which covers getActiveMessageRole
 * / getActiveAgentId). Here we exercise the Map<workspaceId, SessionEntry> readers
 * by injecting entries via the established `as unknown as {…}` sessions-map cast.
 * All injected entries are removed in finally blocks so the shared singleton stays
 * clean for other suites in the aggregate runner.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { chatAgentService } from '../chat-agent.service'

interface FakeEntry {
  adapter: unknown
  session: { getStatus: () => Record<string, unknown> }
  forwarderCleanups: unknown[]
  workspacePath: string
}

type Injectable = {
  sessions: Map<string, FakeEntry>
  _activeWorkspaceId: string | null
}

function makeEntry(status: Record<string, unknown> = { status: 'idle' }): FakeEntry {
  return {
    adapter: { role: 'specialist' },
    session: { getStatus: () => status },
    forwarderCleanups: [],
    workspacePath: '/tmp/fake'
  }
}

function withEntries(ids: string[], fn: (svc: Injectable) => void): void {
  const svc = chatAgentService as unknown as Injectable
  const originalActive = svc._activeWorkspaceId
  const preExisting = new Set(ids.filter((id) => svc.sessions.has(id)))
  for (const id of ids) if (!preExisting.has(id)) svc.sessions.set(id, makeEntry())
  try {
    fn(svc)
  } finally {
    for (const id of ids) if (!preExisting.has(id)) svc.sessions.delete(id)
    svc._activeWorkspaceId = originalActive
  }
}

describe('ChatAgentService — workspace accessors', () => {
  test('getSessionForWorkspace returns the injected session, undefined otherwise', () => {
    withEntries(['ws-a'], () => {
      assert.ok(chatAgentService.getSessionForWorkspace('ws-a'))
      assert.equal(chatAgentService.getSessionForWorkspace('does-not-exist'), undefined)
    })
  })

  test('getAdapterForWorkspace returns the injected adapter', () => {
    withEntries(['ws-b'], () => {
      const adapter = chatAgentService.getAdapterForWorkspace('ws-b') as { role: string }
      assert.equal(adapter.role, 'specialist')
      assert.equal(chatAgentService.getAdapterForWorkspace('missing'), undefined)
    })
  })

  test('hasSessionForWorkspace reflects presence', () => {
    withEntries(['ws-c'], () => {
      assert.equal(chatAgentService.hasSessionForWorkspace('ws-c'), true)
      assert.equal(chatAgentService.hasSessionForWorkspace('nope'), false)
    })
  })

  test('getAllStatuses tags each status with its workspaceId', () => {
    withEntries(['ws-d', 'ws-e'], () => {
      const statuses = chatAgentService.getAllStatuses()
      assert.equal(statuses.get('ws-d')?.workspaceId, 'ws-d')
      assert.equal(statuses.get('ws-e')?.workspaceId, 'ws-e')
    })
  })

  test('setActiveWorkspace / activeWorkspaceId round-trip', () => {
    withEntries([], () => {
      chatAgentService.setActiveWorkspace('ws-active')
      assert.equal(chatAgentService.activeWorkspaceId, 'ws-active')
      chatAgentService.setActiveWorkspace(null)
      assert.equal(chatAgentService.activeWorkspaceId, null)
    })
  })

  test('activeSessionCount counts injected sessions', () => {
    const svc = chatAgentService as unknown as Injectable
    const before = svc.sessions.size
    withEntries(['ws-f', 'ws-g'], () => {
      assert.equal(chatAgentService.activeSessionCount, before + 2)
    })
    assert.equal(chatAgentService.activeSessionCount, before)
  })
})

// ── getStatus ──

describe('ChatAgentService — getStatus', () => {
  test('no active session → returns idle specialist status', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      const status = chatAgentService.getStatus()
      assert.equal(status.status, 'idle')
      assert.equal(status.agentType, 'specialist')
      assert.equal(status.elapsedMs, 0)
      assert.equal(status.tokenUsage, 0)
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('no active session → workspaceId is undefined when no activeWorkspaceId', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      const status = chatAgentService.getStatus()
      assert.equal(status.workspaceId, undefined)
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('with active workspace but no session → includes workspaceId', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = 'ws-status-test'
    try {
      const status = chatAgentService.getStatus()
      assert.equal(status.workspaceId, 'ws-status-test')
      assert.equal(status.status, 'idle')
    } finally {
      svc._activeWorkspaceId = original
    }
  })
})

// ── Backward-compatible getters (no session) ──

describe('ChatAgentService — backward-compatible getters (no session)', () => {
  test('getWorkspacePath → null when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getWorkspacePath(), null)
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getCurrentConversationId → null when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getCurrentConversationId(), null)
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getStreamedContent → empty string when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getStreamedContent(), '')
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getMode → plan when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getMode(), 'plan')
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('isRunning → false when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.isRunning(), false)
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getCacheEfficiency → zero-filled report when no active session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      const report = chatAgentService.getCacheEfficiency()
      assert.equal(report.hitRate, 0)
      assert.equal(report.savedTokens, 0)
      assert.equal(report.totalInput, 0)
      assert.equal(report.turns, 0)
      assert.deepEqual(report.turnBreakdown, [])
    } finally {
      svc._activeWorkspaceId = original
    }
  })
})

// ── Role/agent accessors ──

describe('ChatAgentService — role accessors', () => {
  test('getActiveRole → specialist when no session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getActiveRole(), 'specialist')
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getActiveAgentId → specialist when no session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getActiveAgentId(), 'specialist')
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getActiveMessageRole → specialist when no session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getActiveMessageRole(), 'specialist')
    } finally {
      svc._activeWorkspaceId = original
    }
  })

  test('getActivePersona → null when no session', () => {
    const svc = chatAgentService as unknown as Injectable
    const original = svc._activeWorkspaceId
    svc._activeWorkspaceId = null
    try {
      assert.equal(chatAgentService.getActivePersona(), null)
    } finally {
      svc._activeWorkspaceId = original
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

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
    adapter: { role: 'da-vinci' },
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
      assert.equal(adapter.role, 'da-vinci')
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

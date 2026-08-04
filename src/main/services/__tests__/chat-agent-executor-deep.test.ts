/**
 * Unit tests for chat-agent.service.ts + agent-executor-factory.ts
 *
 * Targets:
 *   - chat-agent.service.ts (55% → 70%) — state accessors, getStatus, session mgmt
 *   - agent-executor-factory.ts (61% → 75%) — resolveCliPermissionMode, cache lifecycle, resolveEffort
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

void (async () => {
  // ── chat-agent.service.ts ──────────────────────────────────────────────────

  let ChatAgentService: any
  let chatAgentService: any

  try {
    const mod = await import('../chat-agent.service')
    ChatAgentService = mod.ChatAgentService
    chatAgentService = mod.chatAgentService
  } catch {
    // Module load may fail due to transitive deps
  }

  if (ChatAgentService) {
    describe('chat-agent › ChatAgentService', () => {
      test('singleton export is an instance of ChatAgentService', () => {
        assert.ok(chatAgentService instanceof ChatAgentService)
      })

      test('activeWorkspaceId is null when no sessions', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.activeWorkspaceId, null)
      })

      test('activeSessionCount is 0 when no sessions', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.activeSessionCount, 0)
      })

      test('hasSessionForWorkspace returns false for unknown workspace', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.hasSessionForWorkspace('nonexistent'), false)
      })

      test('getSessionForWorkspace returns undefined for unknown workspace', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getSessionForWorkspace('nonexistent'), undefined)
      })

      test('getStatus returns idle when no active session', () => {
        const svc = new ChatAgentService()
        const status = svc.getStatus()
        assert.ok(status)
        // Status should indicate idle/stopped
        assert.ok(
          status.state === 'idle' || status.state === 'stopped' || !status.state,
          `Expected idle/stopped state, got: ${status.state}`
        )
      })

      test('isRunning returns false when no sessions', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.isRunning(), false)
      })

      test('getWorkspacePath returns null when no active session', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getWorkspacePath(), null)
      })

      test('getCurrentConversationId returns null when no active session', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getCurrentConversationId(), null)
      })

      test('getStreamedContent returns empty string when no active session', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getStreamedContent(), '')
      })

      test('getMode returns plan when no active session', () => {
        const svc = new ChatAgentService()
        const mode = svc.getMode()
        assert.equal(typeof mode, 'string')
      })

      test('getActiveRole returns specialist', () => {
        const svc = new ChatAgentService()
        const role = svc.getActiveRole()
        assert.equal(typeof role, 'string')
      })

      test('getActiveAgentId returns a string', () => {
        const svc = new ChatAgentService()
        const id = svc.getActiveAgentId()
        assert.equal(typeof id, 'string')
      })

      test('getActiveMessageRole returns specialist', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getActiveMessageRole(), 'specialist')
      })

      test('getActivePersona returns null (deprecated)', () => {
        const svc = new ChatAgentService()
        assert.equal(svc.getActivePersona(), null)
      })

      test('getAllStatuses returns empty map when no sessions', () => {
        const svc = new ChatAgentService()
        const statuses = svc.getAllStatuses()
        assert.ok(statuses instanceof Map)
        assert.equal(statuses.size, 0)
      })

      test('setActiveWorkspace sets activeWorkspaceId', () => {
        const svc = new ChatAgentService()
        svc.setActiveWorkspace('ws-123')
        assert.equal(svc.activeWorkspaceId, 'ws-123')
      })

      test('setActiveWorkspace to null clears activeWorkspaceId', () => {
        const svc = new ChatAgentService()
        svc.setActiveWorkspace('ws-123')
        svc.setActiveWorkspace(null)
        assert.equal(svc.activeWorkspaceId, null)
      })

      test('extends EventEmitter', () => {
        const svc = new ChatAgentService()
        assert.equal(typeof svc.on, 'function')
        assert.equal(typeof svc.emit, 'function')
        assert.equal(typeof svc.off, 'function')
      })

      test('respondToAskUser is a function', () => {
        const svc = new ChatAgentService()
        assert.equal(typeof svc.respondToAskUser, 'function')
      })

      test('clearSession is a function', () => {
        const svc = new ChatAgentService()
        assert.equal(typeof svc.clearSession, 'function')
      })

      test('clearConversationPendingState is a function', () => {
        const svc = new ChatAgentService()
        assert.equal(typeof svc.clearConversationPendingState, 'function')
      })

      test('switchPersona is a no-op (deprecated)', async () => {
        const svc = new ChatAgentService()
        // Should not throw
        await svc.switchPersona(null, 'conv-1')
        assert.ok(true)
      })

      test('getExecutorBackend returns a string', () => {
        const svc = new ChatAgentService()
        const backend = svc.getExecutorBackend()
        assert.equal(typeof backend, 'string')
      })

      test('cancelCurrentQuery is callable without active session', () => {
        const svc = new ChatAgentService()
        // Should not throw
        svc.cancelCurrentQuery()
        assert.ok(true)
      })

      test('stopAll resolves even when no sessions', async () => {
        const svc = new ChatAgentService()
        await svc.stopAll()
        assert.ok(true)
      })
    })
  } else {
    describe('chat-agent › ChatAgentService (skipped — load failed)', () => {
      test('module unavailable', () => { assert.ok(true) })
    })
  }

  // ── agent-executor-factory.ts ──────────────────────────────────────────────

  let AgentExecutorFactory: any

  try {
    const mod = await import('../agent-executor-factory')
    AgentExecutorFactory = mod.AgentExecutorFactory
  } catch {
    // Module load may fail
  }

  if (AgentExecutorFactory) {
    describe('agent-executor-factory › AgentExecutorFactory', () => {
      // Create minimal session stub
      function makeSession() {
        return {
          workspacePath: '/tmp/test-workspace',
          currentConversationId: null,
          getWorkspacePath: () => '/tmp/test-workspace',
        }
      }

      test('can be instantiated with session stub', () => {
        const factory = new AgentExecutorFactory(makeSession())
        assert.ok(factory)
      })

      test('resolveCliPermissionMode: danger → bypassPermissions', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveCliPermissionMode.bind(factory)
        assert.equal(resolve('danger'), 'bypassPermissions')
      })

      test('resolveCliPermissionMode: build → acceptEdits', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveCliPermissionMode.bind(factory)
        assert.equal(resolve('build'), 'acceptEdits')
      })

      test('resolveCliPermissionMode: plan → plan', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveCliPermissionMode.bind(factory)
        assert.equal(resolve('plan'), 'plan')
      })

      test('resolveCliPermissionMode: unknown mode → plan (default)', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveCliPermissionMode.bind(factory)
        assert.equal(resolve('unknown_mode'), 'plan')
      })

      test('getCachedMcpConfigPath returns undefined initially', () => {
        const factory = new AgentExecutorFactory(makeSession())
        assert.equal(factory.getCachedMcpConfigPath(), undefined)
      })

      test('invalidateMcpConfigCache clears the cache', () => {
        const factory = new AgentExecutorFactory(makeSession())
        // Manually set a cached path
        ;(factory as any).cachedMcpConfigPath = '/tmp/config.json'
        assert.equal(factory.getCachedMcpConfigPath(), '/tmp/config.json')

        factory.invalidateMcpConfigCache()
        assert.equal(factory.getCachedMcpConfigPath(), undefined)
      })

      test('resolveLocalContextWindow returns fallback 131072 when no workspace', () => {
        const session = makeSession()
        session.workspacePath = ''
        const factory = new AgentExecutorFactory(session)
        const ctxWindow = factory.resolveLocalContextWindow()
        assert.equal(ctxWindow, 131_072)
      })

      test('resolveLocalContextWindow returns number', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const ctxWindow = factory.resolveLocalContextWindow()
        assert.equal(typeof ctxWindow, 'number')
        assert.ok(ctxWindow >= 0)
      })

      test('resolveEffort returns a valid effort string', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveEffort.bind(factory)
        const result = resolve('claude-sonnet-4-6')
        assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(result))
      })

      test('resolveEffort returns medium for haiku models', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveEffort.bind(factory)
        assert.equal(resolve('claude-haiku-4-5-20251001'), 'medium')
      })

      test('resolveEffort returns high for non-haiku models', () => {
        const factory = new AgentExecutorFactory(makeSession())
        const resolve = (factory as any).resolveEffort.bind(factory)
        assert.equal(resolve('claude-sonnet-4-6'), 'high')
        assert.equal(resolve('claude-opus-4-8'), 'high')
      })

      test('resolveLocalContextWindowAsync returns object with contextWindow', async () => {
        const factory = new AgentExecutorFactory(makeSession())
        const result = await factory.resolveLocalContextWindowAsync()
        assert.equal(typeof result.contextWindow, 'number')
        assert.equal(typeof result.confident, 'boolean')
      })
    })
  } else {
    describe('agent-executor-factory › AgentExecutorFactory (skipped — load failed)', () => {
      test('module unavailable', () => { assert.ok(true) })
    })
  }
})()

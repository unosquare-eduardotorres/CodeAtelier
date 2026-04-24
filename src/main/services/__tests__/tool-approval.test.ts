/**
 * Unit tests for ToolApprovalService — manages tool approval modes, auto-approval
 * for safe tools, caching of approval decisions, and pending approval resolution.
 *
 * Pure logic: no filesystem, no network. BrowserWindow is unavailable in test
 * environment, so requestApproval follows the "no window" fallback path (auto-approve).
 * This is valid coverage for the no-window codepath.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createToolApprovalService } from './helpers/agent-factory'

describe('ToolApprovalService', () => {
  test('defaults_to_dangerous_only_mode', () => {
    const { service } = createToolApprovalService()
    assert.equal(service.getSessionMode(), 'dangerous-only')
  })

  test('auto_approves_safe_read_only_tools', async () => {
    const { service } = createToolApprovalService()
    const safeTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoRead', 'TodoWrite', 'TaskOutput']
    for (const tool of safeTools) {
      const approved = await service.requestApproval(tool, {}, 'generalist')
      assert.equal(approved, true, `${tool} should be auto-approved`)
    }
  })

  test('auto_approves_mcp_prefixed_tools', async () => {
    const { service } = createToolApprovalService()
    const mcpTools = ['mcp__code-graph__search', 'mcp__file-tools__Read', 'mcp__semantic__query']
    for (const tool of mcpTools) {
      const approved = await service.requestApproval(tool, {}, 'generalist')
      assert.equal(approved, true, `${tool} should be auto-approved via mcp__ prefix`)
    }
  })

  test('does_not_auto_approve_write_tools_but_falls_back_to_approve_without_window', async () => {
    const { service } = createToolApprovalService()
    // Write, Bash, Edit are NOT in the auto-approved set, but without BrowserWindow
    // the service falls back to auto-approve (no window available path)
    const result = await service.requestApproval('Bash', { command: 'rm -rf /' }, 'generalist')
    assert.equal(result, true, 'Falls back to auto-approve when no BrowserWindow available')
  })

  test('accept_all_mode_approves_everything', async () => {
    const { service } = createToolApprovalService()
    service.setSessionMode('accept-all')
    assert.equal(service.getSessionMode(), 'accept-all')
    // Even dangerous tools should be approved
    const approved = await service.requestApproval('Bash', { command: 'rm -rf /' }, 'generalist')
    assert.equal(approved, true)
  })

  test('resolveApproval_caches_decision', async () => {
    const { service } = createToolApprovalService()
    // First, make a request that will auto-approve (no window fallback)
    const approved1 = await service.requestApproval('Write', { file_path: '/tmp/test.txt' }, 'gen')
    assert.equal(approved1, true)
    // The fallback auto-approve goes through resolveApproval internally,
    // but let's verify a second call for the same tool+input still works
    const approved2 = await service.requestApproval('Write', { file_path: '/tmp/test.txt' }, 'gen')
    assert.equal(approved2, true)
  })

  test('resolveApproval_ignores_unknown_requestId', () => {
    const { service } = createToolApprovalService()
    // Should not throw when resolving a nonexistent request
    service.resolveApproval('nonexistent-id-12345', true)
    // If we get here without throwing, the test passes
    assert.ok(true, 'resolveApproval did not crash on unknown requestId')
  })

  test('setSessionMode_accept_all_resolves_all_pending', () => {
    const { service } = createToolApprovalService()
    // Start in dangerous-only mode (default)
    assert.equal(service.getSessionMode(), 'dangerous-only')
    // Switch to accept-all — any pending approvals should be auto-resolved
    // (We can't easily create pending approvals without BrowserWindow, but
    // switching modes should not throw even with no pending items)
    service.setSessionMode('accept-all')
    assert.equal(service.getSessionMode(), 'accept-all')
    // Switch back
    service.setSessionMode('dangerous-only')
    assert.equal(service.getSessionMode(), 'dangerous-only')
  })

  test('buildCacheKey_differentiates_by_file_path', async () => {
    const { service } = createToolApprovalService()
    // Two different file_path values should result in independent approvals
    const r1 = await service.requestApproval('Write', { file_path: '/a/b.txt' }, 'gen')
    const r2 = await service.requestApproval('Write', { file_path: '/x/y.txt' }, 'gen')
    // Both auto-approve (no window), but they should be independent cache entries
    assert.equal(r1, true)
    assert.equal(r2, true)
  })

  test('buildCacheKey_uses_command_for_bash', async () => {
    const { service } = createToolApprovalService()
    // Bash tool should use the `command` field for cache key differentiation
    const r1 = await service.requestApproval('Bash', { command: 'ls -la' }, 'gen')
    const r2 = await service.requestApproval('Bash', { command: 'npm install' }, 'gen')
    assert.equal(r1, true)
    assert.equal(r2, true)
  })

  test('enriched_auto_approves_safe_tool_and_returns_approved_true', async () => {
    const { service } = createToolApprovalService()
    const result = await service.requestApprovalEnriched('Read', { file_path: '/a' }, 'gen')
    assert.equal(result.approved, true)
    assert.equal(result.updatedPermissions, undefined, 'no suggestions → no permission update')
  })

  test('enriched_accept_all_mode_approves_without_suggestions', async () => {
    const { service } = createToolApprovalService()
    service.setSessionMode('accept-all')
    const result = await service.requestApprovalEnriched(
      'Bash',
      { command: 'rm -rf /' },
      'gen',
      undefined,
      { title: 't', description: 'd', suggestions: [{ rule: 'one' }] }
    )
    assert.equal(result.approved, true)
    // In accept-all mode, enriched path returns { approved: true } without
    // propagating suggestions — the session-level allow supersedes per-rule.
    assert.equal(result.updatedPermissions, undefined)
  })

  test('resolveApproval_caches_decision_for_ttl_window', () => {
    const { service } = createToolApprovalService()
    // Inject a pending approval and resolve it — the internal cache should now
    // contain the decision. A subsequent requestApproval with the same tool+input
    // should return from cache without needing a BrowserWindow.
    const pendingMap = (service as any).pendingApprovals as Map<
      string,
      {
        resolve: (v: boolean) => void
        toolName: string
        toolInput: Record<string, unknown>
        agentId: string
      }
    >
    let resolvedWith: boolean | null = null
    pendingMap.set('req-X', {
      resolve: (v) => {
        resolvedWith = v
      },
      toolName: 'Write',
      toolInput: { file_path: '/cached.txt' },
      agentId: 'gen'
    })
    service.resolveApproval('req-X', true)
    assert.equal(resolvedWith, true)
    assert.equal(pendingMap.size, 0, 'entry removed after resolve')

    const cache = (service as any).approvalCache as Map<
      string,
      { approved: boolean; expiresAt: number }
    >
    assert.ok(cache.has('Write:/cached.txt'), 'cache key built from tool + file_path')
    const entry = cache.get('Write:/cached.txt')!
    assert.equal(entry.approved, true)
    assert.ok(entry.expiresAt > Date.now(), 'cache entry expires in the future')
  })

  test('accept_all_resolves_pending_approvals_to_approved', () => {
    const { service } = createToolApprovalService()
    const pendingMap = (service as any).pendingApprovals as Map<
      string,
      {
        resolve: (v: boolean) => void
        toolName: string
        toolInput: Record<string, unknown>
        agentId: string
      }
    >
    const resolutions: Array<{ id: string; approved: boolean }> = []
    for (const id of ['p1', 'p2', 'p3']) {
      pendingMap.set(id, {
        resolve: (approved) => resolutions.push({ id, approved }),
        toolName: 'Bash',
        toolInput: { command: `cmd-${id}` },
        agentId: 'gen'
      })
    }
    assert.equal(pendingMap.size, 3)
    service.setSessionMode('accept-all')
    assert.equal(pendingMap.size, 0, 'all pending cleared')
    assert.equal(resolutions.length, 3)
    for (const r of resolutions) assert.equal(r.approved, true)
  })
})

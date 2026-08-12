/**
 * Message identity resolution — what name the chat header shows.
 *
 * Regression: a freshly created greenfield project rendered its header as
 * `workspace-specialist-62e0180c91c4af14c3ff127d561a3b55`. The specialist row
 * existed and was already named "COEOrgChart Specialist", but resolution only
 * consulted it once `build_status` reached 'ready', so a `pending` row fell
 * through to a last-resort branch that printed the raw agent id.
 *
 * The load-bearing property is the last group: no branch may ever return a
 * string containing a raw agent id.
 *
 * Run: tsx src/renderer/src/components/chat/__tests__/message-identity.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../../main/services/__tests__/test-harness'
import { resolveMessageIdentity } from '../resolveMessageIdentity'
import type { IdentityProjectSpecialist, MessageIdentityInput } from '../resolveMessageIdentity'
import { humaniseAgentId } from '../../../utils/agentIdentity'

const WS_ID = '62e0180c91c4af14c3ff127d561a3b55'
const WS_AGENT_ID = `workspace-specialist-${WS_ID}`

const pendingSpecialist: IdentityProjectSpecialist = {
  displayName: 'COEOrgChart Specialist',
  color: '#6366F1',
  buildStatus: 'pending'
}

/** Baseline input: greenfield workspace, message from its workspace specialist. */
function input(overrides: Partial<MessageIdentityInput> = {}): MessageIdentityInput {
  return {
    message: { role: 'specialist', agentId: WS_AGENT_ID },
    specialists: [],
    workspaces: [{ id: WS_ID, name: 'COEOrgChart' }],
    workspaceId: WS_ID,
    projectSpecialist: pendingSpecialist,
    mannequinKey: 'mannequin-main',
    ...overrides
  } as MessageIdentityInput
}

// ── The reported bug ──

describe('resolveMessageIdentity — greenfield project specialist', () => {
  test('a pending specialist shows its project name, not the agent id', () => {
    const identity = resolveMessageIdentity(input())
    assert.equal(identity.displayName, 'COEOrgChart Specialist')
  })

  test('a pending specialist is labelled as not built yet', () => {
    assert.equal(resolveMessageIdentity(input()).subtitle, 'Not built yet')
  })

  test('building and failed rows carry the same label', () => {
    for (const buildStatus of ['building', 'failed'] as const) {
      const identity = resolveMessageIdentity(
        input({ projectSpecialist: { ...pendingSpecialist, buildStatus } })
      )
      assert.equal(identity.displayName, 'COEOrgChart Specialist')
      assert.equal(identity.subtitle, 'Not built yet')
    }
  })

  test('a ready specialist has no subtitle — unchanged behaviour', () => {
    const identity = resolveMessageIdentity(
      input({ projectSpecialist: { ...pendingSpecialist, buildStatus: 'ready' } })
    )
    assert.equal(identity.displayName, 'COEOrgChart Specialist')
    assert.equal(identity.subtitle, null)
  })

  test('no specialist row yet → the workspace name still names the agent', () => {
    // The store loads asynchronously; until it does, the id itself encodes the
    // workspace, so the header can be derived rather than dumped.
    const identity = resolveMessageIdentity(input({ projectSpecialist: null }))
    assert.equal(identity.displayName, 'COEOrgChart Specialist')
  })
})

// ── Unchanged paths ──

describe('resolveMessageIdentity — established behaviour', () => {
  test('user messages use the user specialist alias', () => {
    const identity = resolveMessageIdentity(
      input({
        message: { role: 'user', agentId: undefined },
        specialists: [{ agentId: 'user', displayName: 'User', alias: 'Eduardo', color: '#fff' }]
      })
    )
    assert.equal(identity.displayName, 'Eduardo')
  })

  test('user messages fall back to "You"', () => {
    const identity = resolveMessageIdentity(
      input({ message: { role: 'user', agentId: undefined } })
    )
    assert.equal(identity.displayName, 'You')
  })

  test('a registered specialist resolves by agentId with its alias as subtitle', () => {
    const identity = resolveMessageIdentity(
      input({
        message: { role: 'specialist', agentId: 'frontend-architect' },
        projectSpecialist: null,
        specialists: [
          {
            agentId: 'frontend-architect',
            displayName: 'Frontend Architect',
            alias: 'Ada',
            color: '#F59E0B'
          }
        ]
      })
    )
    assert.equal(identity.displayName, 'Ada')
    assert.equal(identity.subtitle, 'Frontend Architect')
  })

  test('a specialist message with no agentId and no row uses the core default', () => {
    const identity = resolveMessageIdentity(
      input({ message: { role: 'specialist', agentId: undefined }, projectSpecialist: null })
    )
    assert.equal(identity.displayName, 'Agent')
  })
})

// ── The invariant ──

describe('resolveMessageIdentity — never renders a raw agent id', () => {
  const cases: { label: string; agentId: string }[] = [
    { label: 'workspace specialist for an unknown workspace', agentId: WS_AGENT_ID },
    { label: 'workspace specialist for another workspace', agentId: 'workspace-specialist-abc123' },
    { label: 'kebab-case agent', agentId: 'db-architect' },
    { label: 'snake_case agent', agentId: 'code_reviewer' }
  ]

  for (const { label, agentId } of cases) {
    test(`${label} is humanised`, () => {
      const identity = resolveMessageIdentity(
        input({
          message: { role: 'specialist', agentId },
          projectSpecialist: null,
          workspaces: [],
          workspaceId: undefined
        })
      )
      assert.equal(
        identity.displayName.includes(agentId),
        false,
        `displayName leaked the raw id: ${identity.displayName}`
      )
      assert.equal(identity.displayName.includes('-'), false)
      assert.equal(identity.displayName.includes('_'), false)
    })
  }

  test('an agent id with no readable part falls back to the role', () => {
    const identity = resolveMessageIdentity(
      input({ message: { role: 'specialist', agentId: '---' }, projectSpecialist: null })
    )
    assert.equal(identity.displayName, 'specialist')
  })
})

// ── The helper ──

describe('humaniseAgentId', () => {
  test('drops a trailing 32-char hex id', () => {
    assert.equal(humaniseAgentId(WS_AGENT_ID), 'Workspace Specialist')
  })

  test('drops a trailing uuid', () => {
    assert.equal(
      humaniseAgentId('workspace-specialist-62e0180c-91c4-4f14-83ff-127d561a3b55'),
      'Workspace Specialist'
    )
  })

  test('keeps short trailing segments that are part of the name', () => {
    assert.equal(humaniseAgentId('agent-v2'), 'Agent V2')
  })

  test('title-cases kebab and snake case', () => {
    assert.equal(humaniseAgentId('db-architect'), 'Db Architect')
    assert.equal(humaniseAgentId('code_reviewer'), 'Code Reviewer')
  })

  test('returns null when nothing readable survives', () => {
    assert.equal(humaniseAgentId('---'), null)
    assert.equal(humaniseAgentId(''), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

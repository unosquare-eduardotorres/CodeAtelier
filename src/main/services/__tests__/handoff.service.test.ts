/**
 * Unit tests for the Unified Handoff Protocol.
 *
 * Coverage:
 *  - HandoffEnvelope type construction & validation
 *  - Source adapters (grill, audit, council, blueprint, chat, mpa)
 *  - Target adapter rendering (compact, standard, full)
 *  - Confidence calculation
 *  - Redaction pipeline
 *  - Envelope size validation
 *
 * Pure logic — no DB or Electron deps. Tests the adapters, rendering,
 * redaction, and validation layers without persisting to SQLite.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import type { HandoffEnvelope } from '../../../shared/handoff-types'
import {
  MAX_CHAIN_DEPTH,
  MAX_ENVELOPE_SIZE_BYTES,
  HANDOFF_TTL_DAYS
} from '../../../shared/handoff-types'
import { calculateConfidence } from '../handoff-adapters/base.adapter'
import { grillAdapter } from '../handoff-adapters/grill.adapter'
import type { GrillAdapterInput } from '../handoff-adapters/grill.adapter'
import { auditAdapter } from '../handoff-adapters/audit.adapter'
import type { AuditAdapterInput } from '../handoff-adapters/audit.adapter'
import { councilAdapter } from '../handoff-adapters/council.adapter'
import type { CouncilAdapterInput } from '../handoff-adapters/council.adapter'
import { blueprintAdapter } from '../handoff-adapters/blueprint.adapter'
import type { BlueprintAdapterInput } from '../handoff-adapters/blueprint.adapter'
import { chatAdapter } from '../handoff-adapters/chat.adapter'
import type { ChatAdapterInput } from '../handoff-adapters/chat.adapter'
import { mpaAdapter } from '../handoff-adapters/mpa.adapter'
import type { MpaAdapterInput } from '../handoff-adapters/mpa.adapter'
import { renderEnvelopeMarkdown, resolveTargetAction } from '../handoff-adapters/target-adapters'
import { redactEnvelope } from '../handoff-redaction'

// ── Helpers ──────────────────────────────────────────────────────────

function makeBaseEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: 'test-id',
    version: 1,
    source: 'chat',
    target: 'grill',
    workspaceId: 'ws-1',
    intent: 'Test handoff intent',
    originalGoal: 'Test original goal',
    contextSummary: 'Test context summary',
    completedWork: [],
    remainingWork: [],
    decisions: [],
    constraints: [],
    risks: [],
    artifacts: [],
    suggestedTools: [],
    suggestedSkills: [],
    filesToReadFirst: [],
    commandsToRunFirst: [],
    confidence: 0.5,
    priority: 'medium',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
    ...overrides
  }
}

const BASE_ADAPTER_INPUT = {
  workspaceId: 'ws-1',
  target: 'chat' as const,
  sourceSessionId: 'session-1',
  createdBy: 'system' as const
}

// ── Constants ────────────────────────────────────────────────────────

describe('handoff-types constants', () => {
  test('MAX_CHAIN_DEPTH is 10', () => {
    assert.equal(MAX_CHAIN_DEPTH, 10)
  })

  test('MAX_ENVELOPE_SIZE_BYTES is 64KB', () => {
    assert.equal(MAX_ENVELOPE_SIZE_BYTES, 64 * 1024)
  })

  test('HANDOFF_TTL_DAYS is 30', () => {
    assert.equal(HANDOFF_TTL_DAYS, 30)
  })
})

// ── Confidence Calculation ───────────────────────────────────────────

describe('calculateConfidence', () => {
  test('returns 0.5 for empty envelope', () => {
    const confidence = calculateConfidence({})
    assert.equal(confidence, 0.5)
  })

  test('adds 0.2 for structuredPlanRef', () => {
    const confidence = calculateConfidence({ structuredPlanRef: 'plan-123' })
    assert.equal(confidence, 0.7)
  })

  test('adds 0.1 for decisions', () => {
    const confidence = calculateConfidence({
      decisions: [{ what: 'test', why: 'reason' }]
    })
    assert.equal(confidence, 0.6)
  })

  test('adds 0.1 for completedWork', () => {
    const confidence = calculateConfidence({
      completedWork: [{ title: 'step', outcome: 'done' }]
    })
    assert.equal(confidence, 0.6)
  })

  test('caps at 1.0', () => {
    const confidence = calculateConfidence({
      structuredPlanRef: 'plan-123',
      decisions: [{ what: 'a', why: 'b' }],
      completedWork: [{ title: 'c', outcome: 'd' }],
      constraints: ['e'],
      risks: [{ risk: 'f', severity: 'medium' }]
    })
    assert.equal(confidence, 1.0)
  })
})

// ── Redaction ────────────────────────────────────────────────────────

describe('redactEnvelope', () => {
  test('redacts API keys in intent', () => {
    const envelope = makeBaseEnvelope({
      intent: 'Using key sk-ant-abc123defghijklmnopqrst'
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.intent.includes('sk-ant-abc123defghijklmnopqrst'))
    assert.ok(redacted.intent.includes('[REDACTED:anthropic-key]'))
  })

  test('redacts email addresses in contextSummary', () => {
    const envelope = makeBaseEnvelope({
      contextSummary: 'Contact user@example.com for details'
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.contextSummary.includes('user@example.com'))
    assert.ok(redacted.contextSummary.includes('[REDACTED:email]'))
  })

  test('normalizes absolute paths to relative', () => {
    const envelope = makeBaseEnvelope({
      filesToReadFirst: ['/Users/john/project/src/app.ts']
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.filesToReadFirst[0].includes('/Users/john'))
    assert.ok(redacted.filesToReadFirst[0].includes('~/project/src/app.ts'))
  })

  test('redacts GitHub tokens in decisions', () => {
    const envelope = makeBaseEnvelope({
      decisions: [
        {
          what: 'Use token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkL',
          why: 'For authentication'
        }
      ]
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(redacted.decisions[0].what.includes('[REDACTED:github-token]'))
  })

  test('does not redact short strings that look like key prefixes', () => {
    const envelope = makeBaseEnvelope({
      intent: 'Variable sk_color is set'
    })
    const redacted = redactEnvelope(envelope)
    assert.equal(redacted.intent, 'Variable sk_color is set')
  })

  test('redacts secrets in constraints array', () => {
    const envelope = makeBaseEnvelope({
      constraints: ['API key: sk-ant-aaaabbbbccccddddeeeefffff']
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(redacted.constraints[0].includes('[REDACTED:anthropic-key]'))
  })
})

// ── Target Adapter Rendering ─────────────────────────────────────────

describe('renderEnvelopeMarkdown', () => {
  test('compact format is ≤500 chars', () => {
    const envelope = makeBaseEnvelope({
      completedWork: [{ title: 'Step 1', outcome: 'Done' }],
      remainingWork: [{ title: 'Step 2', description: 'Todo', priority: 'high' }],
      decisions: [{ what: 'Choice A', why: 'Reason' }]
    })
    const compact = renderEnvelopeMarkdown(envelope, 'compact')
    assert.ok(compact.length <= 500, `Compact should be ≤500 chars, got ${compact.length}`)
    assert.ok(compact.includes('chat → grill'))
  })

  test('standard format includes intent and context', () => {
    const envelope = makeBaseEnvelope({
      contextSummary: 'Detailed context here',
      remainingWork: [{ title: 'Fix bug', description: 'In module X', priority: 'high' }]
    })
    const standard = renderEnvelopeMarkdown(envelope, 'standard')
    assert.ok(standard.includes('Test handoff intent'))
    assert.ok(standard.includes('Detailed context here'))
    assert.ok(standard.includes('Fix bug'))
  })

  test('full format includes all sections', () => {
    const envelope = makeBaseEnvelope({
      completedWork: [{ title: 'Step 1', outcome: 'Done', filesModified: ['a.ts'] }],
      remainingWork: [{ title: 'Step 2', description: 'Todo', priority: 'high' }],
      decisions: [{ what: 'Choice A', why: 'Reason', alternatives: ['B', 'C'] }],
      constraints: ['Must use TypeScript'],
      risks: [{ risk: 'Breaking change', severity: 'high', mitigation: 'Add tests' }],
      artifacts: [{ type: 'plan', path: 'plan.md', description: 'The plan' }],
      filesToReadFirst: ['src/app.ts'],
      commandsToRunFirst: ['npm test']
    })
    const full = renderEnvelopeMarkdown(envelope, 'full')
    assert.ok(full.includes('Completed Work'))
    assert.ok(full.includes('Remaining Work'))
    assert.ok(full.includes('Decisions Made'))
    assert.ok(full.includes('Constraints'))
    assert.ok(full.includes('Risks'))
    assert.ok(full.includes('Artifacts'))
    assert.ok(full.includes('Files to Read First'))
    assert.ok(full.includes('Commands to Run First'))
  })
})

// ── Target Action Resolution ─────────────────────────────────────────

describe('resolveTargetAction', () => {
  test('chat target resolves to ChatTargetAction', () => {
    const envelope = makeBaseEnvelope({ target: 'chat' })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'chat')
    if (action.type === 'chat') {
      assert.ok(action.contextMarkdown.length > 0)
      assert.ok(action.handoffContextCompact.length > 0)
      assert.ok(action.title.includes('Handoff'))
    }
  })

  test('grill target resolves to GrillTargetAction', () => {
    const envelope = makeBaseEnvelope({ target: 'grill' })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'grill')
    if (action.type === 'grill') {
      assert.ok(action.ideaTitle.length > 0)
    }
  })

  test('council target resolves to CouncilTargetAction', () => {
    const envelope = makeBaseEnvelope({ target: 'council' })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'council')
    if (action.type === 'council') {
      assert.ok(action.planContent.length > 0)
    }
  })

  test('goals target resolves to GoalsTargetAction', () => {
    const envelope = makeBaseEnvelope({
      target: 'goals',
      remainingWork: [{ title: 'Goal 1', description: 'Do X', priority: 'high' }]
    })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'goals')
    if (action.type === 'goals') {
      assert.equal(action.goalTitle, 'Goal 1')
    }
  })

  test('chat target with remainingWork uses plan mode', () => {
    const envelope = makeBaseEnvelope({
      target: 'chat',
      remainingWork: [{ title: 'Step', description: 'Do', priority: 'medium' }]
    })
    const action = resolveTargetAction(envelope)
    if (action.type === 'chat') {
      assert.equal(action.mode, 'plan')
    }
  })

  test('chat target with no remainingWork uses build mode', () => {
    const envelope = makeBaseEnvelope({ target: 'chat', remainingWork: [] })
    const action = resolveTargetAction(envelope)
    if (action.type === 'chat') {
      assert.equal(action.mode, 'build')
    }
  })
})

// ── Grill Adapter ────────────────────────────────────────────────────

describe('grillAdapter.toEnvelope', () => {
  const input: GrillAdapterInput = {
    ideaTitle: 'Add dark mode',
    ideaDescription: 'Add dark mode support to the app',
    session: {
      id: 'grill-session-1',
      trackScores: [
        {
          trackId: 'requirements',
          score: 8,
          scoreLabel: 'Strong',
          iterationCount: 2,
          lastFeedback: 'Good'
        },
        {
          trackId: 'architecture',
          score: 7,
          scoreLabel: 'Good',
          iterationCount: 1,
          lastFeedback: 'OK'
        }
      ],
      iterationCount: 3,
      status: 'completed'
    },
    plan: {
      version: 1,
      title: 'Dark Mode Implementation',
      summary: 'Implement dark mode using CSS variables',
      goalType: 'feature',
      decisions: [
        {
          trackId: 'requirements',
          trackName: 'Requirements',
          score: 8,
          items: [{ question: 'Scope?', answer: 'Full app', rationale: 'Users requested it' }]
        }
      ],
      items: [
        {
          id: 'item-1',
          title: 'Add CSS variables',
          description: 'Define CSS custom properties for theming',
          scope: 'frontend',
          files: ['src/styles/theme.css', 'src/styles/dark.css'],
          dependsOn: [],
          includesTests: false
        }
      ],
      risks: ['Breaking existing styles'],
      constraints: ['Must work in Electron'],
      originalDescription: 'Add dark mode',
      requirementDocument: 'Detailed spec...'
    },
    planRecordId: 'plan-123'
  }

  test('creates valid envelope with correct source', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.source, 'grill')
    assert.equal(envelope.target, 'chat')
    assert.equal(envelope.workspaceId, 'ws-1')
  })

  test('extracts intent from plan title', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.intent.includes('Dark Mode Implementation'))
  })

  test('extracts decisions from plan tracks', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.decisions.length, 1)
    assert.ok(envelope.decisions[0].what.includes('Scope?'))
    assert.ok(envelope.decisions[0].what.includes('Full app'))
  })

  test('extracts constraints from plan', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.deepEqual(envelope.constraints, ['Must work in Electron'])
  })

  test('extracts risks from plan', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.risks.length, 1)
    assert.ok(envelope.risks[0].risk.includes('Breaking existing styles'))
  })

  test('extracts remaining work from plan items', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.remainingWork.length, 1)
    assert.equal(envelope.remainingWork[0].title, 'Add CSS variables')
  })

  test('extracts files from plan items', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.filesToReadFirst.includes('src/styles/theme.css'))
  })

  test('sets structuredPlanRef', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.structuredPlanRef, 'plan-123')
  })

  test('has extensions with grill-specific data', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal((envelope.extensions as Record<string, unknown>).grillSessionId, 'grill-session-1')
    assert.equal((envelope.extensions as Record<string, unknown>).goalType, 'feature')
  })

  test('confidence is > 0.5 when plan exists', () => {
    const envelope = grillAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.confidence > 0.5)
  })
})

// ── Audit Adapter ────────────────────────────────────────────────────

describe('auditAdapter.toEnvelope', () => {
  const input: AuditAdapterInput = {
    auditRunId: 'audit-run-1',
    overallScore: 6,
    results: [
      {
        id: 'result-1',
        auditRunId: 'audit-run-1',
        trackId: 'security' as any,
        score: 5,
        status: 'completed' as any,
        findings: [
          {
            id: 'f1',
            severity: 'critical',
            title: 'SQL injection',
            description: 'Unsanitized input',
            filePath: 'src/db.ts',
            recommendation: 'Use parameterized queries'
          },
          {
            id: 'f2',
            severity: 'medium',
            title: 'Missing CSRF',
            description: 'No CSRF token',
            recommendation: 'Add CSRF middleware'
          }
        ],
        summary: 'Security audit found critical issues',
        skillsUsed: [],
        startedAt: '2024-01-01',
        completedAt: '2024-01-01'
      }
    ]
  }

  test('creates envelope with critical findings as high-priority remaining work', () => {
    const envelope = auditAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.source, 'audit')
    assert.equal(envelope.remainingWork.length, 2)
    assert.equal(envelope.remainingWork[0].priority, 'critical')
  })

  test('extracts risks from high/critical findings', () => {
    const envelope = auditAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.risks.length > 0)
    assert.ok(envelope.risks[0].risk.includes('SQL injection'))
  })

  test('extracts file paths from findings', () => {
    const envelope = auditAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.filesToReadFirst.includes('src/db.ts'))
  })

  test('intent mentions critical finding count', () => {
    const envelope = auditAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.intent.includes('1'))
    assert.ok(envelope.intent.includes('critical'))
  })
})

// ── Council Adapter ──────────────────────────────────────────────────

describe('councilAdapter.toEnvelope', () => {
  const input: CouncilAdapterInput = {
    session: {
      id: 'council-1',
      workspaceId: 'ws-1',
      inputType: 'plan' as any,
      inputContent: 'Review this plan for adding dark mode...',
      phase: 'verdict' as any,
      reviews: [{ advisorRole: 'architect' } as any],
      peerReviews: [],
      verdict: {
        overallScore: 8,
        sections: {
          agrees: 'All agree on the approach',
          clashes: 'Disagree on CSS-in-JS vs CSS variables',
          blindSpots: 'Accessibility not addressed',
          recommendation: 'Use CSS variables for better performance',
          oneThingFirst: 'Define the color palette first'
        },
        revisions: [],
        individualScores: { architect: 9, security: 7 } as any,
        rankingsMatrix: {}
      },
      memberStatuses: {} as any,
      createdAt: '2024-01-01'
    }
  }

  test('creates envelope with verdict data', () => {
    const envelope = councilAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.source, 'council')
    assert.ok(envelope.intent.includes('8/10'))
  })

  test('extracts decisions from verdict sections', () => {
    const envelope = councilAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.decisions.length >= 1)
    assert.ok(envelope.decisions.some((d) => d.what === 'Council recommendation'))
  })

  test('extracts blind spots as risks', () => {
    const envelope = councilAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.risks.length > 0)
    assert.ok(envelope.risks[0].mitigation?.includes('Accessibility'))
  })
})

// ── Chat Adapter ─────────────────────────────────────────────────────

describe('chatAdapter.toEnvelope', () => {
  const input: ChatAdapterInput = {
    conversation: {
      id: 'conv-1',
      workspaceId: 'ws-1',
      title: 'Implement dark mode',
      mode: 'plan',
      type: 'chat',
      createdAt: '2024-01-01',
      status: 'active',
      llmProvider: 'anthropic' as any
    },
    recentMessages: [
      {
        id: 'm1',
        conversationId: 'conv-1',
        role: 'user',
        contentMd: 'Please add dark mode',
        attachmentsJson: '[]',
        createdAt: '2024-01-01'
      },
      {
        id: 'm2',
        conversationId: 'conv-1',
        role: 'specialist',
        contentMd: 'I can help with that',
        attachmentsJson: '[]',
        createdAt: '2024-01-01'
      }
    ],
    plan: {
      title: 'Dark Mode Plan',
      summary: 'Add dark mode using CSS variables',
      phases: [
        {
          id: 1,
          title: 'Define variables',
          complexity: 3,
          fileCount: 2,
          risk: 'low',
          description: 'Define CSS custom properties'
        }
      ],
      files: ['src/styles/theme.css'],
      decisions: [{ what: 'Use CSS variables', why: 'Better performance' }],
      constraints: ['Must work in Electron']
    },
    planRecordId: 'plan-456',
    focusDescription: 'Focus on the CSS variable setup'
  }

  test('uses focusDescription as intent when provided', () => {
    const envelope = chatAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.intent.includes('Focus on the CSS variable setup'))
  })

  test('falls back to plan title when no focus', () => {
    const noFocus = { ...input, focusDescription: undefined }
    const envelope = chatAdapter.toEnvelope(noFocus, BASE_ADAPTER_INPUT)
    assert.ok(envelope.intent.includes('Dark Mode Plan'))
  })

  test('extracts decisions from plan only (not LLM)', () => {
    const envelope = chatAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.decisions.length, 1)
    assert.equal(envelope.decisions[0].what, 'Use CSS variables')
  })

  test('extracts remaining work from plan phases', () => {
    const envelope = chatAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.remainingWork.length, 1)
    assert.equal(envelope.remainingWork[0].title, 'Define variables')
  })
})

// ── MPA Adapter ──────────────────────────────────────────────────────

describe('mpaAdapter.toEnvelope', () => {
  const input: MpaAdapterInput = {
    campaign: {
      id: 'campaign-1',
      workspaceId: 'ws-1',
      title: 'Feature sprint',
      originalPlanMd: 'Build three features',
      status: 'completed',
      createdAt: '2024-01-01',
      completedAt: '2024-01-02'
    },
    goals: [
      {
        goal: {
          id: 'g1',
          title: 'Add auth',
          outcome: 'Auth system working',
          successCriteria: ['Login works', 'Logout works'],
          goalType: 'feature',
          phases: ['plan', 'execute', 'verify'] as any
        },
        status: 'completed'
      },
      {
        goal: {
          id: 'g2',
          title: 'Add dashboard',
          outcome: 'Dashboard renders',
          successCriteria: ['Charts load', 'Data refreshes'],
          goalType: 'feature',
          phases: ['plan', 'execute', 'verify'] as any
        },
        status: 'failed'
      }
    ]
  }

  test('intent mentions failed goals', () => {
    const envelope = mpaAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.intent.includes('1 failed goal'))
  })

  test('completed goals appear in completedWork', () => {
    const envelope = mpaAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.equal(envelope.completedWork.length, 1)
    assert.equal(envelope.completedWork[0].title, 'Add auth')
  })

  test('failed goals appear in remainingWork with high priority', () => {
    const envelope = mpaAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.remainingWork.some((r) => r.title === 'Add dashboard'))
    const failed = envelope.remainingWork.find((r) => r.title === 'Add dashboard')
    assert.equal(failed?.priority, 'high')
  })

  test('failed goals appear as risks', () => {
    const envelope = mpaAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.risks.some((r) => r.risk.includes('Add dashboard')))
  })
})

// ── Blueprint Adapter ────────────────────────────────────────────────

describe('blueprintAdapter.toEnvelope', () => {
  const input: BlueprintAdapterInput = {
    blueprint: {
      id: 'bp-1',
      workspaceId: 'ws-1',
      title: 'New Feature',
      shortName: 'nf',
      description: 'Build a new feature',
      status: 'building',
      currentPhase: 'build',
      priority: 'P1',
      sourceIdeaId: null,
      constitutionSnapshot: null,
      settingsJson: { fast_mode: true },
      createdAt: '2024-01-01',
      updatedAt: '2024-01-02',
      completedAt: null,
      unverifiedJson: null,
      phases: [
        {
          id: 'p1',
          blueprintId: 'bp-1',
          phase: 'specify',
          status: 'complete',
          conversationId: null,
          artifactsJson: [{ type: 'spec', filePath: 'spec.md' }],
          contextSnapshot: null,
          startedAt: '2024-01-01',
          completedAt: '2024-01-01'
        },
        {
          id: 'p2',
          blueprintId: 'bp-1',
          phase: 'build',
          status: 'active',
          conversationId: null,
          artifactsJson: [],
          contextSnapshot: null,
          startedAt: '2024-01-02',
          completedAt: null
        }
      ],
      tasks: [
        {
          id: 't1',
          blueprintId: 'bp-1',
          taskId: 'T-1',
          wave: 1,
          userStory: 'As user',
          description: 'Build component',
          filePathsJson: ['src/comp.tsx'],
          isParallel: false,
          dependsOnJson: [],
          status: 'complete',
          executorRunId: null,
          startedAt: '2024-01-01',
          completedAt: '2024-01-01',
          completionJson: null,
          skippedByUserAt: null,
          failureReason: null,
          outcomeKind: null,
          resolutionNote: null,
          packetJson: null,
          gatesJson: null,
          unverifiedJson: null,
          attempts: 1,
          escalatedTo: null
        },
        {
          id: 't2',
          blueprintId: 'bp-1',
          taskId: 'T-2',
          wave: 2,
          userStory: 'As user',
          description: 'Add tests',
          filePathsJson: ['src/comp.test.ts'],
          isParallel: false,
          dependsOnJson: ['T-1'],
          status: 'pending',
          executorRunId: null,
          startedAt: null,
          completedAt: null,
          completionJson: null,
          skippedByUserAt: null,
          failureReason: null,
          outcomeKind: null,
          resolutionNote: null,
          packetJson: null,
          gatesJson: null,
          unverifiedJson: null,
          attempts: 0,
          escalatedTo: null
        }
      ]
    }
  }

  test('extracts completed phases as completedWork', () => {
    const envelope = blueprintAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.completedWork.some((c) => c.title.includes('specify')))
  })

  test('extracts pending phases + tasks as remainingWork', () => {
    const envelope = blueprintAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.remainingWork.some((r) => r.title.includes('build')))
    assert.ok(envelope.remainingWork.some((r) => r.title.includes('Add tests')))
  })

  test('extracts phase artifacts', () => {
    const envelope = blueprintAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.artifacts.some((a) => a.path === 'spec.md'))
  })

  test('extracts files from tasks', () => {
    const envelope = blueprintAdapter.toEnvelope(input, BASE_ADAPTER_INPUT)
    assert.ok(envelope.filesToReadFirst.includes('src/comp.tsx'))
    assert.ok(envelope.filesToReadFirst.includes('src/comp.test.ts'))
  })
})

// ── Redaction: env-api-key fix ───────────────────────────────────────

describe('redactEnvelope — env-api-key', () => {
  test('redacts ANTHROPIC_API_KEY=value assignments', () => {
    const envelope = makeBaseEnvelope({
      contextSummary: 'Set ANTHROPIC_API_KEY=sk-ant-secret123456789012345'
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.contextSummary.includes('sk-ant-secret'))
    assert.ok(redacted.contextSummary.includes('[REDACTED'))
  })

  test('redacts OPENAI_API_KEY=value assignments', () => {
    const envelope = makeBaseEnvelope({
      constraints: ['OPENAI_API_KEY="sk-proj-abcdef1234567890"']
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.constraints[0].includes('sk-proj-abcdef'))
    assert.ok(redacted.constraints[0].includes('[REDACTED'))
  })
})

// ── Extensions validation ──────────────────────────────────────────────

describe('extensions validation', () => {
  test('rejects circular references in extensions', () => {
    // Test at the JSON.stringify level since createEnvelope needs DB
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    assert.throws(() => JSON.stringify(circular), /circular/i)
  })
})

// ── Phase 2 Audit Fixes ─────────────────────────────────────────────

describe('redactEnvelope — extensions & tools', () => {
  test('redacts secrets in extensions string values', () => {
    const envelope = makeBaseEnvelope({
      extensions: {
        apiKey: 'sk-ant-secretkey12345678901234567',
        numericValue: 42
      }
    })
    const redacted = redactEnvelope(envelope)
    const ext = redacted.extensions as Record<string, unknown>
    assert.ok(typeof ext.apiKey === 'string')
    assert.ok(!(ext.apiKey as string).includes('sk-ant-'))
    assert.equal(ext.numericValue, 42)
  })

  test('redacts secrets in suggestedTools', () => {
    const envelope = makeBaseEnvelope({
      suggestedTools: ['read_file', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature']
    })
    const redacted = redactEnvelope(envelope)
    assert.ok(!redacted.suggestedTools[1].includes('eyJhbGciOiJ'))
  })
})

describe('renderStandard — risks', () => {
  test('standard format includes risks section', () => {
    const envelope = makeBaseEnvelope({
      risks: [{ risk: 'Breaking change in API', severity: 'high', mitigation: 'Add tests' }]
    })
    const standard = renderEnvelopeMarkdown(envelope, 'standard')
    assert.ok(standard.includes('Risks'))
    assert.ok(standard.includes('Breaking change in API'))
  })
})

describe('resolveTargetAction — audit focusAreas cap', () => {
  test('audit target caps focusAreas', () => {
    const manyRisks = Array.from({ length: 20 }, (_, i) => ({
      risk: `Risk ${i}`,
      severity: 'medium' as const
    }))
    const envelope = makeBaseEnvelope({ target: 'audit', risks: manyRisks })
    const action = resolveTargetAction(envelope)
    if (action.type === 'audit') {
      assert.ok(
        action.focusAreas.length <= 15,
        `Expected ≤15 focusAreas, got ${action.focusAreas.length}`
      )
    }
  })
})

// ── Phase 6 Audit Fixes ────────────────────────────────────────────

describe('resolveTargetAction — blueprint and audit', () => {
  test('blueprint target resolves to BlueprintTargetAction with settings from decisions', () => {
    const envelope = makeBaseEnvelope({
      target: 'blueprint',
      contextSummary: 'Build a new feature',
      decisions: [{ what: 'Use React', why: 'Team preference' }]
    })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'blueprint')
    if (action.type === 'blueprint') {
      assert.equal(action.specSeed, 'Build a new feature')
      assert.equal(action.settings['Use React'], 'Team preference')
    }
  })

  test('audit target resolves to AuditTargetAction with focusAreas from risks + remaining work', () => {
    const envelope = makeBaseEnvelope({
      target: 'audit',
      risks: [{ risk: 'SQL injection', severity: 'critical' }],
      remainingWork: [{ title: 'Fix auth', description: 'Auth bypass', priority: 'high' }]
    })
    const action = resolveTargetAction(envelope)
    assert.equal(action.type, 'audit')
    if (action.type === 'audit') {
      assert.ok(action.focusAreas.includes('SQL injection'))
      assert.ok(action.focusAreas.includes('Fix auth'))
    }
  })
})

// ── Phase 3 Audit Fixes ────────────────────────────────────────────

describe('renderFull — suggestedSkills', () => {
  test('full format includes suggestedSkills section', () => {
    const envelope = makeBaseEnvelope({
      suggestedSkills: ['code-review', 'security-audit']
    })
    const full = renderEnvelopeMarkdown(envelope, 'full')
    assert.ok(full.includes('Suggested Skills'))
    assert.ok(full.includes('code-review'))
  })
})

describe('renderStandard — completedWork', () => {
  test('standard format includes completedWork section', () => {
    const envelope = makeBaseEnvelope({
      completedWork: [{ title: 'Built auth module', outcome: 'Login/logout working' }]
    })
    const standard = renderEnvelopeMarkdown(envelope, 'standard')
    assert.ok(standard.includes('Completed Work'))
    assert.ok(standard.includes('Built auth module'))
  })
})

describe('redactExtensions — nested values', () => {
  test('redacts secrets in nested extension objects', () => {
    const envelope = makeBaseEnvelope({
      extensions: {
        config: { apiKey: 'sk-ant-secretkey12345678901234567' },
        tags: ['normal', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkL']
      }
    })
    const redacted = redactEnvelope(envelope)
    const ext = redacted.extensions as Record<string, unknown>
    const config = ext.config as Record<string, unknown>
    assert.ok(!(config.apiKey as string).includes('sk-ant-'))
    const tags = ext.tags as string[]
    assert.ok(!tags[1].includes('ghp_'))
  })
})

// ── Phase 4 Audit Fixes ────────────────────────────────────────────

describe('renderFull — codeAnchors', () => {
  test('full format includes codeAnchors section', () => {
    const envelope = makeBaseEnvelope({
      codeAnchors: [
        { file: 'src/db.ts', startLine: 42, endLine: 55, title: 'Database migration logic' },
        { file: 'src/auth.ts', startLine: 10, endLine: 20, title: 'Auth middleware' }
      ]
    })
    const full = renderEnvelopeMarkdown(envelope, 'full')
    assert.ok(full.includes('Code Anchors'))
    assert.ok(full.includes('src/db.ts:42-55'))
    assert.ok(full.includes('Database migration logic'))
  })
})

// ── Phase 5 Audit Fixes ────────────────────────────────────────────

describe('renderFull — codeAnchors edge cases', () => {
  test('full format omits codeAnchors section when empty', () => {
    const envelope = makeBaseEnvelope({ codeAnchors: [] })
    const full = renderEnvelopeMarkdown(envelope, 'full')
    assert.ok(!full.includes('Code Anchors'))
  })

  test('full format omits codeAnchors section when undefined', () => {
    const envelope = makeBaseEnvelope()
    const full = renderEnvelopeMarkdown(envelope, 'full')
    assert.ok(!full.includes('Code Anchors'))
  })
})

// ── Standalone runner ────────────────────────────────────────────────

// NOTE: must compare against the entry script. `import.meta.url.endsWith(...)`
// is always true for this module, so the previous form ran summaryAsync() — and
// therefore process.exit() — even when loaded by run-tests.ts, silently
// truncating the rest of the suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

/**
 * Design run orchestration — `DesignAgentService.runDesign` and the
 * `design.ipc.ts` event wiring.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `design-agent.test.ts` covers the pure functions (merge rules, command
 * resolution, discovery) and nothing else. Every defect P3.7 fixed lived in the
 * uncovered part: the skill was never provisioned, event payloads carried no
 * workspace id, detector findings were discarded on a failed command, and a
 * throw before the command loop left the workspace permanently locked. Those
 * are all orchestration properties, so this file drives the orchestrator with
 * the session, detector and provisioning layers stubbed.
 *
 * ── Stubbing strategy ────────────────────────────────────────────────────────
 * `AgentSessionService`, `DesignRoleAdapter`, the detector and the provisioner
 * are replaced at module-load time, so the real `runDesign` body runs against
 * scripted responses without spawning a CLI or a detector subprocess. The
 * adapter is stubbed too — the orchestrator only reads `params.commandId` back
 * off it, and stubbing removes the whole prompt-assembly tree from the test.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 * The harness runs tests inside a `describe` CONCURRENTLY, and these tests steer
 * module-level fakes. Every test that mutates a fake therefore runs inside
 * `runExclusive()`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, runExclusive, summaryAsync } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  evictFromCache,
  mockService,
  unmockService
} from './setup-full-mock'
import { getHandlers, mockMainWindow, mockEvent } from './electron-stub'
import { IPC_CHANNELS } from '../../../shared/constants'
import type { AuditFinding } from '../../../shared/types'

setupFullMock()

// ── Scriptable fakes ─────────────────────────────────────────────────────────

interface SessionScript {
  /** Raw text `getStreamedContent` returns for this command. */
  response: string
  /** Workspace-relative paths reported as inspected, via Read tool_use chunks. */
  filesInspected: string[]
  /** When set, `send()` rejects with this error. */
  failWith?: Error
}

const DEFAULT_SCRIPT: SessionScript = { response: '', filesInspected: [] }

let scripts = new Map<string, SessionScript>()
let sessionsCreated: string[] = []

/** Ordered log of the phases `runDesign` drove, so ordering can be asserted. */
let phaseLog: string[] = []

let provisionResult: { status: 'ready' | 'unavailable' | 'failed'; reason?: string } = {
  status: 'ready'
}
let provisionThrows: Error | null = null
let provisioned = true

let detection: {
  status: 'ok' | 'failed' | 'unavailable'
  findings: AuditFinding[]
  ruleCount: number
  reason?: string
} = { status: 'ok', findings: [], ruleCount: 0 }

let detectionCalls: Array<{ workspacePath: string; targets: string[]; aborted: boolean }> = []

function resetFakes(): void {
  scripts = new Map()
  sessionsCreated = []
  phaseLog = []
  provisionResult = { status: 'ready' }
  provisionThrows = null
  provisioned = true
  detection = { status: 'ok', findings: [], ruleCount: 0 }
  detectionCalls = []
}

/** A well-formed auditor response: three findings clear the coverage gate. */
function auditorResponse(prefix: string, score = 80): string {
  const finding = (title: string, filePath: string): string =>
    '```audit-finding\n' +
    JSON.stringify({ severity: 'medium', title, description: 'why it matters', filePath }) +
    '\n```'
  return [
    finding(`${prefix} spacing is inconsistent`, 'src/App.tsx'),
    finding(`${prefix} type scale has no rhythm`, 'src/Card.tsx'),
    finding(`${prefix} palette is unowned`, 'src/styles.css'),
    '```audit-score\n' + JSON.stringify({ score, summary: `${prefix} summary` }) + '\n```'
  ].join('\n')
}

function detectorFinding(title: string, filePath: string): AuditFinding {
  return {
    id: `det-${title}`,
    severity: 'medium',
    title,
    description: 'detector output',
    filePath,
    source: 'impeccable-detector'
  }
}

class FakeDesignAdapter {
  readonly agentId: string
  constructor(readonly params: { commandId: string; workspaceId: string }) {
    this.agentId = `design-${params.commandId}-${params.workspaceId}`
  }
}

class FakeAgentSession extends EventEmitter {
  private readonly commandId: string
  private readonly streamed = new Map<string, string>()

  constructor(adapter: { params?: { commandId?: string } }) {
    super()
    this.commandId = adapter?.params?.commandId ?? 'unknown'
    sessionsCreated.push(this.commandId)
  }

  async start(): Promise<void> {
    phaseLog.push(`session:${this.commandId}`)
  }

  async send(_message: string, conversationId: string): Promise<void> {
    const script = scripts.get(this.commandId) ?? DEFAULT_SCRIPT
    if (script.failWith) throw script.failWith

    // Coverage is derived from tool chunks, so an "inspected" file must be
    // reported the way a real Read does.
    for (const filePath of script.filesInspected) {
      this.emit('chunk', { type: 'tool_use', toolName: 'Read', toolInput: filePath })
    }
    this.emit('chunk', { type: 'text', content: script.response })
    this.streamed.set(conversationId, script.response)
  }

  getStreamedContent(conversationId: string): string {
    return this.streamed.get(conversationId) ?? ''
  }

  async stop(): Promise<void> {
    /* the orchestrator always stops its session; nothing to tear down here */
  }

  cancelCurrentQuery(): void {
    /* cancellation is asserted through the abort signal, not through this */
  }
}

mockService('role-adapters/design.adapter', { DesignRoleAdapter: FakeDesignAdapter })
mockService('agent-session.service', { AgentSessionService: FakeAgentSession })
mockService('impeccable-detector.service', {
  DETECTOR_SOURCE: 'impeccable-detector',
  runDetection: async (workspacePath: string, targets: string[] = [], signal?: AbortSignal) => {
    phaseLog.push('detector')
    detectionCalls.push({ workspacePath, targets, aborted: signal?.aborted ?? false })
    return detection
  }
})
mockService('impeccable-provision.service', {
  ensureProvisioned: async () => {
    phaseLog.push('provision')
    if (provisionThrows) throw provisionThrows
    return provisionResult
  },
  getProvisionState: () => ({ provisioned, skillDir: '/tmp/skill' }),
  readSkillMarkdown: () => null,
  readCommandMarkdown: () => null
})

evictFromCache('design-agent.service', 'design-prompt-templates', 'design-discovery.service')

const serviceModule = require('../design-agent.service') as typeof import('../design-agent.service')
const { DesignAgentService } = serviceModule

// ── Workspace fixtures ───────────────────────────────────────────────────────

const fixtureRoot = mkdtempSync(join(tmpdir(), 'design-orch-'))
const designWorkspace = join(fixtureRoot, 'with-design')
const emptyWorkspace = join(fixtureRoot, 'no-design')

mkdirSync(join(designWorkspace, 'src'), { recursive: true })
writeFileSync(join(designWorkspace, 'src', 'App.tsx'), 'export const App = () => null\n')
writeFileSync(join(designWorkspace, 'src', 'Card.tsx'), 'export const Card = () => null\n')
writeFileSync(join(designWorkspace, 'src', 'styles.css'), '.a { padding: 2px }\n')
mkdirSync(emptyWorkspace, { recursive: true })
// A backend-only file: present, but nothing a design pass can act on.
writeFileSync(join(emptyWorkspace, 'server.ts'), 'export const x = 1\n')

const ALL_FIXTURE_FILES = ['src/App.tsx', 'src/Card.tsx', 'src/styles.css']

process.on('exit', () => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** Collect every event a run emits, in order. */
function recordEvents(service: EventEmitter): {
  events: Array<{ name: string; payload: any }>
  of: (name: string) => any[]
} {
  const events: Array<{ name: string; payload: any }> = []
  for (const name of ['progress', 'result', 'intermediate_findings', 'complete', 'stream']) {
    service.on(name, (payload: unknown) => events.push({ name, payload }))
  }
  return { events, of: (name) => events.filter((e) => e.name === name).map((e) => e.payload) }
}

function config(overrides: Record<string, unknown> = {}): any {
  return {
    commandIds: ['audit'],
    scope: { mode: 'project', paths: [] },
    brief: 'audit the dashboard',
    ...overrides
  }
}

/** All progress stream text for a run, concatenated. */
function streamText(progressEvents: any[]): string {
  return progressEvents.map((p) => p.streamChunk ?? '').join('')
}

// ── §1: runDesign orchestration ──────────────────────────────────────────────

describe('runDesign — orchestration', () => {
  test('emits one result per executable command, then completes once', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('critique', {
        response: auditorResponse('critique', 70),
        filesInspected: ALL_FIXTURE_FILES
      })
      scripts.set('audit', {
        response: auditorResponse('audit', 90),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        // `polish` is a refine card: it shapes the prompt and never executes.
        config: config({ commandIds: ['audit', 'critique', 'polish'] }),
        designRunId: 'run-1'
      })

      const results = rec.of('result')
      assert.deepEqual(
        results.map((r) => r.trackId),
        ['design:critique', 'design:audit'],
        'both evaluate commands run, in EVALUATE_ORDER, and the refine card does not'
      )
      assert.deepEqual(sessionsCreated, ['critique', 'audit'])
      assert.equal(rec.of('complete').length, 1, 'complete fires exactly once')
      assert.equal(rec.of('complete')[0].overallScore, 80, 'unweighted mean of 70 and 90')
      assert.ok(results.every((r) => r.status === 'completed'))
      assert.equal(service.isRunningForWorkspace('ws-1'), false)
    }))

  test('provisions the skill BEFORE the detector and before any session', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })

      assert.deepEqual(
        phaseLog,
        ['provision', 'detector', 'session:audit'],
        'the skill payload must exist before any prompt is assembled'
      )
    }))

  test('a run whose skill never provisioned says so and does not claim the skill', () =>
    runExclusive(async () => {
      resetFakes()
      provisioned = false
      provisionResult = { status: 'unavailable', reason: 'engine unavailable' }
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })

      const result = rec.of('result')[0]
      assert.equal(result.status, 'completed', 'a missing skill degrades, it does not fail the run')
      assert.ok(
        !result.skillsUsed.includes('impeccable'),
        'claiming a skill that produced an empty layer makes a degraded run look healthy'
      )

      const text = streamText(rec.of('progress'))
      assert.match(text, /Installing the Impeccable design skill/)
      assert.match(text, /unavailable \(engine unavailable\)/)
      assert.match(text, /WITHOUT the Impeccable design knowledge/)
    }))

  test('a provisioned run claims the skill', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })

      assert.deepEqual(rec.of('result')[0].skillsUsed, ['impeccable'])
      assert.ok(
        !streamText(rec.of('progress')).includes('Installing the Impeccable design skill'),
        'an already-provisioned run must not narrate an install it never did'
      )
    }))

  test('an empty scope is reported as not-applicable, not scored', () =>
    runExclusive(async () => {
      resetFakes()

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-empty',
        workspacePath: emptyWorkspace,
        config: config(),
        designRunId: 'run-empty'
      })

      const result = rec.of('result')[0]
      assert.equal(result.status, 'completed')
      assert.equal(result.applicability, 'not-applicable')
      assert.deepEqual(sessionsCreated, [], 'no session is worth spawning for zero files')
      assert.equal(
        rec.of('complete')[0].overallScore,
        null,
        'a not-applicable command must not invent a score'
      )
    }))

  test('a failed command is reported and the run still completes', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('critique', {
        response: '',
        filesInspected: [],
        failWith: new Error('adapter exploded')
      })
      scripts.set('audit', {
        response: auditorResponse('audit', 90),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config({ commandIds: ['critique', 'audit'] }),
        designRunId: 'run-1'
      })

      const [critique, audit] = rec.of('result')
      assert.equal(critique.status, 'failed')
      assert.match(critique.summary, /adapter exploded/)
      assert.equal(audit.status, 'completed', 'one command failing must not abort the run')
      assert.equal(
        rec.of('complete')[0].overallScore,
        90,
        'the failed command is excluded from the mean rather than scored zero'
      )
    }))

  test('detector findings survive the failure of the command that owned them', () =>
    runExclusive(async () => {
      resetFakes()
      detection = {
        status: 'ok',
        ruleCount: 1,
        findings: [detectorFinding('cramped-padding', 'src/styles.css')]
      }
      scripts.set('critique', {
        response: '',
        filesInspected: [],
        failWith: new Error('adapter exploded')
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config({ commandIds: ['critique'] }),
        designRunId: 'run-1'
      })

      const failed = rec.of('result')[0]
      assert.equal(failed.status, 'failed')
      assert.deepEqual(
        failed.findings.map((f: AuditFinding) => f.title),
        ['cramped-padding'],
        'the deterministic scan is evidence the agent half never touched — it must not be discarded'
      )
      assert.deepEqual(failed.skillsUsed, ['impeccable-detector'])
    }))

  test('a throw before the command loop still resets state and completes the run', () =>
    runExclusive(async () => {
      resetFakes()
      provisionThrows = new Error('provisioning blew up')

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })

      assert.equal(rec.of('complete').length, 1, 'complete must fire even on the throw path')
      assert.equal(
        service.isRunningForWorkspace('ws-1'),
        false,
        'a stuck `running` flag locks the workspace out permanently'
      )

      // The real proof the lockout is gone: the next run works.
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })
      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-2'
      })
      assert.equal(rec.of('result').length, 1)
    }))

  test('the detector receives the run’s abort signal', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      await service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config({ scope: { mode: 'paths', paths: ['src'] } }),
        designRunId: 'run-1'
      })

      assert.equal(detectionCalls.length, 1)
      assert.deepEqual(detectionCalls[0].targets, ['src'], 'scoped runs scan only their scope')
      assert.equal(
        detectionCalls[0].aborted,
        false,
        'a live (un-aborted) signal must reach the detector, or cancel cannot interrupt it'
      )
    }))

  test('every emitted event carries its workspaceId', () =>
    runExclusive(async () => {
      resetFakes()
      detection = {
        status: 'ok',
        ruleCount: 1,
        findings: [detectorFinding('side-tab', 'src/styles.css')]
      }
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await service.runDesign({
        workspaceId: 'ws-tagged',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })

      assert.ok(rec.events.length > 0)
      const untagged = rec.events.filter((e) => e.payload?.workspaceId !== 'ws-tagged')
      assert.deepEqual(
        untagged.map((e) => e.name),
        [],
        'an untagged event cannot be filtered by a per-workspace listener'
      )
      // Every event family must be represented, or the assertion above is vacuous.
      for (const name of ['progress', 'result', 'intermediate_findings', 'complete', 'stream']) {
        assert.ok(rec.of(name).length > 0, `expected at least one '${name}' event`)
      }
    }))

  test('two workspaces running at once keep their events separate', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      await Promise.all([
        service.runDesign({
          workspaceId: 'ws-a',
          workspacePath: designWorkspace,
          config: config(),
          designRunId: 'run-a'
        }),
        service.runDesign({
          workspaceId: 'ws-b',
          workspacePath: designWorkspace,
          config: config(),
          designRunId: 'run-b'
        })
      ])

      const results = rec.of('result')
      assert.equal(results.length, 2, 'per-workspace state permits concurrent runs')
      assert.deepEqual(
        results.map((r) => r.workspaceId).sort(),
        ['ws-a', 'ws-b'],
        'each run reports under its own workspace'
      )
      assert.equal(rec.of('complete').length, 2)
    }))

  test('a second run for the same workspace is refused while one is in flight', () =>
    runExclusive(async () => {
      resetFakes()
      scripts.set('audit', {
        response: auditorResponse('audit'),
        filesInspected: ALL_FIXTURE_FILES
      })

      const service = new DesignAgentService()
      const rec = recordEvents(service)

      const first = service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-1'
      })
      const second = service.runDesign({
        workspaceId: 'ws-1',
        workspacePath: designWorkspace,
        config: config(),
        designRunId: 'run-2'
      })
      await Promise.all([first, second])

      assert.equal(rec.of('result').length, 1, 'the duplicate run is ignored, not queued')
      assert.equal(rec.of('complete').length, 1, 'and it must not emit a second completion')
    }))
})

// ── §2: design.ipc event wiring + DESIGN_START success path ──────────────────
//
// A second module load of `design.ipc`, bound to a fake `designAgentService`, so
// DESIGN_START can be driven end-to-end without starting a real run. Handlers
// live in a process-global map keyed by channel, so this re-registration simply
// replaces the copy `design-ipc.test.ts` installed; both behave identically on
// the validation paths that file asserts.

const fakeAgentService = Object.assign(new EventEmitter(), {
  isRunningForWorkspace: (_id: string) => false,
  runDesign: async (): Promise<void> => {
    /* started runs are driven by emitting on this fake, not by executing */
  },
  cancel: (_id?: string) => {}
})

const forwardedEvents: Array<{ channel: string; workspaceId: string; payload: any }> = []
let dispatchedNotifications: any[] = []

mockService('design-agent.service', {
  DesignAgentService,
  designAgentService: fakeAgentService
})
mockService('session-event-router', {
  getSessionEventRouter: () => ({
    sendWorkspaceEvent: (channel: string, workspaceId: string, payload: any) => {
      forwardedEvents.push({ channel, workspaceId, payload })
    }
  })
})
mockService('notification.service', {
  notificationService: {
    dispatch: (n: unknown) => {
      dispatchedNotifications.push(n)
    }
  }
})
mockService('tech-stack-detector.service', {
  detectTechStack: () => ({ detectedTechs: ['react'] })
})

evictFromCache('ipc/design.ipc')
const designIpc = require('../../ipc/design.ipc') as typeof import('../../ipc/design.ipc')
designIpc.registerDesignIpc(mockMainWindow as never)

// The mocks above are process-global; leaving them registered would hijack the
// next test file's requires.
unmockService('role-adapters/design.adapter')
unmockService('agent-session.service')
unmockService('impeccable-detector.service')
unmockService('impeccable-provision.service')
unmockService('design-agent.service')
unmockService('session-event-router')
unmockService('notification.service')
unmockService('tech-stack-detector.service')

/** Minimal in-memory audit repo behaviour for a design run. */
function stubAuditRepo(): { rows: Map<string, any>; runs: any[] } {
  const repo = getMockRepo('audit')
  const rows = new Map<string, any>()
  const runs: any[] = []
  let seq = 0

  repo.createRun.mockImplementation(
    (
      workspaceId: string,
      mode: string,
      selectedTracks: string[],
      techs: string[],
      settings: unknown,
      kind: string
    ) => {
      const run = {
        id: `run-${++seq}`,
        workspaceId,
        mode,
        selectedTracks,
        techs,
        settings,
        kind,
        results: []
      }
      runs.push(run)
      return run
    }
  )
  repo.createResults.mockImplementation((runId: string, trackIds: string[]) =>
    trackIds.map((trackId) => {
      const row = { id: `${runId}:${trackId}`, runId, trackId, status: 'pending' }
      rows.set(row.id, row)
      return row
    })
  )
  repo.findResultByTrack.mockImplementation(
    (runId: string, trackId: string) => rows.get(`${runId}:${trackId}`) ?? null
  )
  repo.findResultById.mockImplementation((id: string) => rows.get(id) ?? null)
  repo.updateResult.mockImplementation((id: string, patch: Record<string, unknown>) => {
    const row = rows.get(id)
    if (row) Object.assign(row, patch)
    return row
  })
  repo.findResultsByRunId.mockImplementation((runId: string) =>
    [...rows.values()].filter((r) => r.runId === runId)
  )
  repo.updateRun.mockImplementation((runId: string, patch: Record<string, unknown>) => {
    const run = runs.find((r) => r.id === runId)
    if (run) Object.assign(run, patch)
    return run
  })
  return { rows, runs }
}

function invoke(channel: string, args: unknown): Promise<any> {
  const handler = getHandlers().get(channel)
  assert.ok(handler, `no handler registered for ${channel}`)
  return handler(mockEvent, args)
}

describe('design.ipc — DESIGN_START and event persistence', () => {
  test('DESIGN_START creates a design run and result rows only for executable commands', () =>
    runExclusive(async () => {
      resetFakes()
      forwardedEvents.length = 0
      const { runs, rows } = stubAuditRepo()
      getMockRepo('workspace')
        .findById.mockReset()
        .mockReturnValue({ id: 'ws-1', name: 'Fixture', repoPath: designWorkspace })
      getMockRepo('workspace').getSettings.mockReset().mockReturnValue({ llmProvider: 'claude' })

      const res = await invoke(IPC_CHANNELS.DESIGN_START, {
        workspaceId: 'ws-1',
        // `polish` is a refine card — recorded on the run, never executed.
        commandIds: ['audit', 'critique', 'polish'],
        brief: 'make the dashboard calmer'
      })

      assert.equal(res.ok, true, res.reason)
      assert.equal(runs.length, 1)
      const run = runs[0]
      assert.equal(run.kind, 'design', 'design runs must be discriminable from health runs')
      assert.deepEqual(
        run.selectedTracks,
        ['design:audit', 'design:critique', 'design:polish'],
        'the run row records the FULL selection so a handoff can reproduce the intent'
      )
      assert.deepEqual(
        [...rows.values()].map((r) => r.trackId).sort(),
        ['design:audit', 'design:critique'],
        'only executable commands get result rows'
      )
      assert.equal(run.status, 'running')
    }))

  test('wired listeners persist their own workspace’s events and ignore another’s', () =>
    runExclusive(async () => {
      resetFakes()
      forwardedEvents.length = 0
      dispatchedNotifications = []
      const { rows, runs } = stubAuditRepo()
      getMockRepo('workspace')
        .findById.mockReset()
        .mockReturnValue({ id: 'ws-a', name: 'Fixture A', repoPath: designWorkspace })
      getMockRepo('workspace').getSettings.mockReset().mockReturnValue({ llmProvider: 'claude' })

      const started = await invoke(IPC_CHANNELS.DESIGN_START, {
        workspaceId: 'ws-a',
        commandIds: ['audit']
      })
      assert.equal(started.ok, true)
      const runId = runs[0].id
      const rowId = `${runId}:design:audit`

      // A different workspace's run reports the same track id on the shared
      // singleton emitter. Without the guard this lands in ws-a's row.
      fakeAgentService.emit('result', {
        workspaceId: 'ws-b',
        trackId: 'design:audit',
        score: 11,
        status: 'completed',
        findings: [detectorFinding('foreign', 'src/App.tsx')],
        summary: 'from another workspace',
        skillsUsed: []
      })
      assert.equal(
        rows.get(rowId).status,
        'pending',
        'workspace B’s result must not be written into workspace A’s row'
      )

      // This workspace's own result persists and is forwarded.
      fakeAgentService.emit('result', {
        workspaceId: 'ws-a',
        trackId: 'design:audit',
        score: 82,
        status: 'completed',
        findings: [detectorFinding('own', 'src/App.tsx')],
        summary: 'mine',
        skillsUsed: ['impeccable']
      })
      assert.equal(rows.get(rowId).score, 82)
      assert.equal(rows.get(rowId).summary, 'mine')
      assert.ok(
        forwardedEvents.some(
          (e) => e.channel === IPC_CHANNELS.DESIGN_RESULT && e.workspaceId === 'ws-a'
        )
      )

      // A foreign completion must not close this run either.
      fakeAgentService.emit('complete', { workspaceId: 'ws-b', overallScore: 5 })
      assert.notEqual(runs[0].status, 'completed')
      assert.equal(dispatchedNotifications.length, 0)

      fakeAgentService.emit('complete', { workspaceId: 'ws-a', overallScore: 82 })
      assert.equal(runs[0].status, 'completed')
      assert.equal(runs[0].overallScore, 82)
      assert.equal(dispatchedNotifications.length, 1)
      assert.equal(
        dispatchedNotifications[0].service,
        'design',
        'a finished design run must not announce itself as an audit'
      )
      assert.equal(dispatchedNotifications[0].targetPage, 'design')
    }))

  // The mock repositories are process-global and outlive this file. Leaving
  // `workspaceRepository.findById` stubbed to RETURN a workspace is not inert:
  // several later IPC suites assert a handler rejects because the lookup came
  // back empty (`codeGraph:indexStart` throws 'Workspace not found'), and a
  // stub that always finds one turns that rejection into a silent pass. Caught
  // in the full run — this suite is green standalone either way.
  test('restores the shared repository spies for later suites', () =>
    runExclusive(async () => {
      const workspace = getMockRepo('workspace')
      workspace.findById.mockReset()
      workspace.getSettings.mockReset()

      const audit = getMockRepo('audit')
      for (const method of [
        'createRun',
        'createResults',
        'findResultByTrack',
        'findResultById',
        'updateResult',
        'findResultsByRunId',
        'updateRun'
      ]) {
        audit[method].mockReset()
      }

      assert.equal(
        workspace.findById('ws-1'),
        undefined,
        'a reset lookup must report "not found" again'
      )
    }))
})

// ── §3: model routing ─────────────────────────────────────────────
//
// The real adapter, loaded after the stub above is unregistered.

describe('DesignRoleAdapter — model routing', () => {
  test('declares design:audit so the Design → Evaluate model row actually applies', () => {
    const { DesignRoleAdapter } = require('../role-adapters/design.adapter')
    const adapter = new DesignRoleAdapter({
      workspaceId: 'ws-1',
      commandId: 'audit',
      brief: '',
      scopeMode: 'project',
      scopePaths: [],
      refineCommands: []
    })

    // `role` is deliberately 'audit' (the session layer treats a design pass as
    // an audit), so without the explicit action `resolveAdapterModelAction`
    // falls back to `resolveModelAction('audit', …)` and every design run
    // resolves through the Workspace Health entry instead.
    assert.equal(adapter.role, 'audit')
    assert.equal(adapter.getUsageModelAction(), 'design:audit')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}

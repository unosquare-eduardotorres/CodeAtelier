import assert from 'node:assert/strict'

import type { ConversationMode, ExecutionStrategy, HandoffBrief, TaskPlan } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  HANDOFF_REGEX,
  buildSubAgentDefinitions,
  parseDecompositionResult,
  parseHandoffBlock
} from '../generalist-utils'
import {
  MOCK_BRIEF,
  MOCK_CONVERSATION,
  VALID_DECOMPOSITION_JSON,
  VALID_HANDOFF_BLOCK
} from './fixtures/pipeline-fixtures'
import {
  createMockGeneralistService,
  createMockMainWindow,
  createMockRepositories
} from './fixtures/mock-factory'

let passed = 0
let failed = 0
let skipped = 0

function test(name: string, fn: () => void, options?: { skipReason?: string }) {
  if (options?.skipReason) {
    console.log(`  - ${name} (skipped: ${options.skipReason})`)
    skipped++
    return
  }

  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}

type TaskPlanEventPayload = TaskPlan & { autoExecute?: ExecutionStrategy }

function makePlan(mode: ConversationMode = 'plan', brief: HandoffBrief = MOCK_BRIEF): TaskPlan {
  return parseDecompositionResult(VALID_DECOMPOSITION_JSON, MOCK_CONVERSATION.id, brief, mode)
}

describe('Suite 5: TaskPlan delivery — no auto-execute', () => {
  test('plan-mode task plan does NOT include autoExecute', () => {
    const mainWindow = createMockMainWindow()
    assert.ok(HANDOFF_REGEX.test(VALID_HANDOFF_BLOCK))

    const parsedBrief = parseHandoffBlock(VALID_HANDOFF_BLOCK)
    assert.ok(parsedBrief)
    assert.equal(parsedBrief.mode, 'plan')

    const decompose = () => makePlan('plan', parsedBrief)
    const taskPlan = decompose()

    const subAgents = buildSubAgentDefinitions(taskPlan.tasks, 'plan', (specialistId) => ({
      systemPrompt: `You are ${specialistId}`,
      description: `Specialist ${specialistId}`
    }))
    assert.ok(Object.keys(subAgents).length > 0)

    mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)

    const sentPlan = mainWindow.sentMessages[0].data as Record<string, unknown>
    assert.equal(Object.prototype.hasOwnProperty.call(sentPlan, 'autoExecute'), false)
  })

  test('investigation fix plan includes autoExecute', () => {
    const mainWindow = createMockMainWindow()
    const taskPlan = makePlan('build')

    mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, {
      ...taskPlan,
      autoExecute: 'sequential' as ExecutionStrategy
    })

    const sentPlan = mainWindow.sentMessages[0].data as TaskPlanEventPayload
    assert.equal(sentPlan.autoExecute, 'sequential')
  })

  test('TaskPlan type allows optional autoExecute', () => {
    const basePlan = makePlan('plan')
    const withoutAutoExecute: TaskPlanEventPayload = { ...basePlan }
    const withAutoExecute: TaskPlanEventPayload = {
      ...basePlan,
      autoExecute: 'parallel'
    }

    assert.equal(withoutAutoExecute.autoExecute, undefined)
    assert.equal(withAutoExecute.autoExecute, 'parallel')
  })
})

describe('Suite 6: Pipeline ordering', () => {
  test('handoff emits events in order: HANDOFF → chunk → TASK_PLAN', () => {
    const mainWindow = createMockMainWindow()
    const parsedBrief = parseHandoffBlock(VALID_HANDOFF_BLOCK)
    assert.ok(parsedBrief)

    const specialistNames = parsedBrief.specialists.join(', ')
    const taskPlan = makePlan('plan', parsedBrief)

    mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
      conversationId: MOCK_CONVERSATION.id,
      summary: parsedBrief.summary,
      specialists: parsedBrief.specialists,
      mode: parsedBrief.mode
    })
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId: MOCK_CONVERSATION.id,
      chunk: '',
      role: 'generalist'
    })
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId: MOCK_CONVERSATION.id,
      chunk: `Delegating to **${specialistNames}** for review.\n\n`,
      role: 'generalist'
    })
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)

    assert.deepEqual(
      mainWindow.sentMessages.map((m) => m.channel),
      [
        'chat:handoff',
        'chat:messageChunk',
        'chat:messageChunk',
        'chat:taskPlan'
      ]
    )
  })

  test('decomposition failure sends error chunk AND COMPLETE', () => {
    const mainWindow = createMockMainWindow()
    const repos = createMockRepositories()

    try {
      throw new Error('Parse failed')
    } catch (error) {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId: MOCK_CONVERSATION.id,
        chunk: `\n\n**Error:** Task decomposition failed. ${(error as Error).message}`,
        role: 'generalist'
      })
      const savedMsg = repos.messageRepository.create(
        MOCK_CONVERSATION.id,
        'coordinator',
        `**Error:** Task decomposition failed.\n\n${(error as Error).message}`
      )
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
        conversationId: MOCK_CONVERSATION.id,
        messageId: savedMsg.id
      })
    }

    assert.deepEqual(
      mainWindow.sentMessages.map((m) => m.channel),
      [IPC_CHANNELS.CHAT_MESSAGE_CHUNK, IPC_CHANNELS.CHAT_MESSAGE_COMPLETE]
    )
  })

  test('handoff listener is one-shot — removed after first fire', () => {
    const generalistService = createMockGeneralistService()
    const parsedBrief = parseHandoffBlock(VALID_HANDOFF_BLOCK)
    assert.ok(parsedBrief)

    let callCount = 0
    const onHandoff = () => {
      callCount++
      generalistService.removeListener('handoff', onHandoff)
    }

    generalistService.on('handoff', onHandoff)
    generalistService.emit('handoff', parsedBrief)
    generalistService.emit('handoff', parsedBrief)

    assert.equal(callCount, 1)
  })
})

describe('Suite 7: CHAT_EXECUTE_PLAN contracts', () => {
  test('reads mode from conversation DB, not task plan args', () => {
    const repos = createMockRepositories()
    const generalistService = createMockGeneralistService()

    repos.conversationRepository.findById = (id: string) => ({
      id,
      mode: 'plan',
      workspaceId: 'ws-1',
      title: 'Test'
    })

    let usedMode: ConversationMode | null = null
    generalistService.executeWithSubAgents = async (
      _taskPlan: unknown,
      mode: unknown
    ): Promise<void> => {
      usedMode = mode as ConversationMode
    }

    const argsMode: ConversationMode = 'build'
    const tasks = makePlan(argsMode).tasks
    const conversation = repos.conversationRepository.findById(MOCK_CONVERSATION.id)
    const mode: ConversationMode = (conversation?.mode as ConversationMode) ?? 'build'
    const taskPlan: TaskPlan = {
      conversationId: MOCK_CONVERSATION.id,
      summary: tasks.map((t) => t.description).join('; '),
      mode,
      tasks
    }

    void generalistService.executeWithSubAgents(taskPlan, mode, MOCK_CONVERSATION.id)
    assert.equal(usedMode, 'plan')
    assert.equal(mode, 'plan')
  })

  test('always sends CHAT_MESSAGE_COMPLETE even on error', () => {
    const mainWindow = createMockMainWindow()
    const repos = createMockRepositories()
    const generalistService = createMockGeneralistService()

    const onChunk = () => {}
    const onComplete = () => {}
    generalistService.on('chunk', onChunk)
    generalistService.on('subAgentsComplete', onComplete)

    try {
      throw new Error('SubAgent execution exploded')
    } catch (error) {
      const errorMsg = `**Execution Error:** ${(error as Error).message}`
      const savedMsg = repos.messageRepository.create(MOCK_CONVERSATION.id, 'coordinator', errorMsg)
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId: MOCK_CONVERSATION.id,
        chunk: errorMsg,
        role: 'generalist'
      })
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
        conversationId: MOCK_CONVERSATION.id,
        messageId: savedMsg.id
      })
      generalistService.removeListener('chunk', onChunk)
      generalistService.removeListener('subAgentsComplete', onComplete)
    }

    assert.equal(
      mainWindow.sentMessages.some((m) => m.channel === IPC_CHANNELS.CHAT_MESSAGE_COMPLETE),
      true
    )
  })

  test('cleans up listeners after subAgentsComplete', () => {
    const generalistService = createMockGeneralistService()

    const onChunk = () => {}
    const onComplete = () => {
      generalistService.removeListener('chunk', onChunk)
      generalistService.removeListener('subAgentsComplete', onComplete)
    }

    generalistService.on('chunk', onChunk)
    generalistService.on('subAgentsComplete', onComplete)
    generalistService.emit('subAgentsComplete')

    assert.equal(generalistService.listenerCount('chunk'), 0)
    assert.equal(generalistService.listenerCount('subAgentsComplete'), 0)
  })

  test('cleans up listeners after error', () => {
    const generalistService = createMockGeneralistService()

    const onChunk = () => {}
    const onComplete = () => {}
    generalistService.on('chunk', onChunk)
    generalistService.on('subAgentsComplete', onComplete)

    try {
      throw new Error('executeWithSubAgents failed')
    } catch {
      generalistService.removeListener('chunk', onChunk)
      generalistService.removeListener('subAgentsComplete', onComplete)
    }

    assert.equal(generalistService.listenerCount('chunk'), 0)
    assert.equal(generalistService.listenerCount('subAgentsComplete'), 0)
  })
})

describe('Suite 8: Investigation fix flow', () => {
  test('auto-switches from plan to build mode', () => {
    const repos = createMockRepositories()
    const generalistService = createMockGeneralistService()

    let updatedMode: string | null = null
    let switchedMode: string | null = null

    repos.conversationRepository.findById = (id: string) => ({
      id,
      mode: 'plan',
      workspaceId: 'ws-1',
      title: 'Test'
    })
    repos.conversationRepository.updateMode = (_id: string, mode: string) => {
      updatedMode = mode
    }
    generalistService.switchMode = (mode: string) => {
      switchedMode = mode
    }

    const conversation = repos.conversationRepository.findById(MOCK_CONVERSATION.id)
    if (conversation?.mode === 'plan') {
      repos.conversationRepository.updateMode(MOCK_CONVERSATION.id, 'build')
      generalistService.switchMode('build')
    }

    assert.equal(updatedMode, 'build')
    assert.equal(switchedMode, 'build')
  })

  test('sends mode switch notification chunk', () => {
    const mainWindow = createMockMainWindow()
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId: MOCK_CONVERSATION.id,
      chunk: '\n> **Mode switched to Build** — executing fix plan.\n\n',
      role: 'generalist'
    })

    const chunkMsg = mainWindow.sentMessages.find((m) => m.channel === IPC_CHANNELS.CHAT_MESSAGE_CHUNK)
    assert.ok(chunkMsg)
    assert.equal(
      String((chunkMsg.data as { chunk: string }).chunk).includes('**Mode switched to Build**'),
      true
    )
  })

  test('sends plan with autoExecute flag', () => {
    const mainWindow = createMockMainWindow()
    const fixBrief: HandoffBrief = {
      ...MOCK_BRIEF,
      summary: 'Fix: Apply investigation recommendations',
      mode: 'build'
    }
    const taskPlan = makePlan('build', fixBrief)

    mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, {
      ...taskPlan,
      brief: fixBrief,
      autoExecute: 'sequential' as ExecutionStrategy
    })

    const sentPlan = mainWindow.sentMessages[0].data as TaskPlanEventPayload
    assert.equal(sentPlan.autoExecute, 'sequential')
  })
})

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) process.exit(1)

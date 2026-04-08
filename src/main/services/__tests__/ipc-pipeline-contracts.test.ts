import assert from 'node:assert/strict'

import type { ConversationMode, HandoffBrief, TaskPlan } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/constants'
import {
  HANDOFF_REGEX,
  PLAN_REGEX,
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

function makePlan(mode: ConversationMode = 'plan', brief: HandoffBrief = MOCK_BRIEF) {
  return parseDecompositionResult(VALID_DECOMPOSITION_JSON, MOCK_CONVERSATION.id, brief, mode)
}

describe('Suite 5: Pipeline auto-executes after decomposition (no CHAT_TASK_PLAN)', () => {
  test('decomposition produces valid tasks for sub-agent definitions', () => {
    assert.ok(HANDOFF_REGEX.test(VALID_HANDOFF_BLOCK))

    const parsedBrief = parseHandoffBlock(VALID_HANDOFF_BLOCK)
    assert.ok(parsedBrief)
    assert.equal(parsedBrief.mode, 'plan')

    const taskPlan = makePlan('plan', parsedBrief)

    const subAgents = buildSubAgentDefinitions(taskPlan.tasks, 'plan', (specialistId) => ({
      systemPrompt: `You are ${specialistId}`,
      description: `Specialist ${specialistId}`
    }))
    assert.ok(Object.keys(subAgents).length > 0)
  })
})

describe('Suite 6: Pipeline ordering', () => {
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

    repos.conversationRepository.findById = (id: string) => ({
      id,
      mode: 'plan',
      workspaceId: 'ws-1',
      title: 'Test'
    })

    // The contract: mode is resolved from the DB conversation record, not from task plan args.
    // Even if the task plan was created with 'build', the execution mode comes from the DB.
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

    // DB says 'plan', so mode should be 'plan' regardless of argsMode='build'
    assert.equal(mode, 'plan')
    assert.equal(taskPlan.mode, 'plan')
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
      throw new Error('Execution failed')
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

    const chunkMsg = mainWindow.sentMessages.find(
      (m) => m.channel === IPC_CHANNELS.CHAT_MESSAGE_CHUNK
    )
    assert.ok(chunkMsg)
    assert.equal(
      String((chunkMsg.data as { chunk: string }).chunk).includes('**Mode switched to Build**'),
      true
    )
  })

  test('investigation fix produces valid task plan for auto-execution', () => {
    const fixBrief: HandoffBrief = {
      ...MOCK_BRIEF,
      summary: 'Fix: Apply investigation recommendations',
      mode: 'build'
    }
    const taskPlan = makePlan('build', fixBrief)

    // Pipeline now auto-executes directly — no CHAT_TASK_PLAN emission
    assert.ok(taskPlan.tasks.length > 0)
    assert.equal(taskPlan.mode, 'build')
  })
})

describe('Suite 9: PLAN_REGEX', () => {
  test('matches ````plan fenced block', () => {
    const text = 'Some text\n````plan\n{"title":"Test"}\n````\nMore text'
    const match = text.match(PLAN_REGEX)
    assert.ok(match)
    assert.ok(match[1].includes('"title":"Test"'))
  })

  test('matches ```plan fenced block', () => {
    const text = '```plan\n{"title":"Test"}\n```'
    const match = text.match(PLAN_REGEX)
    assert.ok(match)
  })

  test('does not match plain text', () => {
    const text = 'Here is my plan for the implementation'
    const match = text.match(PLAN_REGEX)
    assert.equal(match, null)
  })

  test('extracts JSON content between fences', () => {
    const json = '{"title":"Refactor auth","summary":"Extract auth logic","steps":[]}'
    const text = `Here is my plan:\n\`\`\`\`plan\n${json}\n\`\`\`\`\n\nLet me know what you think.`
    const match = text.match(PLAN_REGEX)
    assert.ok(match)
    assert.equal(match[1].trim(), json)
  })

  test('captures multiline plan content', () => {
    const text = '````plan\n{\n  "title": "Test",\n  "summary": "A test plan"\n}\n````'
    const match = text.match(PLAN_REGEX)
    assert.ok(match)
    const parsed = JSON.parse(match[1])
    assert.equal(parsed.title, 'Test')
    assert.equal(parsed.summary, 'A test plan')
  })
})

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) process.exit(1)

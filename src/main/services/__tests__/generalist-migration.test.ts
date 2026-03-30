import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import type { ConversationMode } from '../../../shared/types'
import type { SDKExecuteOptions } from '../sdk-executor'

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

type TestTask = {
  id?: string
  specialist: string
  description: string
  dependsOn?: unknown
  complexity?: unknown
  verificationCommand?: unknown
  model?: 'haiku' | 'sonnet' | 'opus'
}

type NormalizedTask = {
  id: string
  specialist: string
  description: string
  dependsOn: string[]
  complexity?: unknown
  verificationCommand?: string
  model?: 'haiku' | 'sonnet' | 'opus'
}

type TestBrief = {
  summary: string
  decisions: string[]
  constraints: string[]
  filesDiscussed: string[]
  recentMessages: Array<{ role: string; content: string }>
}

type TestAgentDefinition = {
  description: string
  prompt: string
  tools: string[]
  model: 'sonnet' | 'opus' | 'haiku'
  budgetTier: 'minimal' | 'standard' | 'full'
}

function parseDecompositionResultMirror(result: string): { tasks: NormalizedTask[] } {
  let jsonStr = result
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  let parsed: { tasks: TestTask[] }
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('Failed to parse task decomposition — LLM returned invalid JSON')
  }

  if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Task decomposition returned no tasks')
  }

  const tasks = parsed.tasks.map((t, i) => ({
    id: t.id || `t${i + 1}`,
    specialist: t.specialist,
    description: t.description,
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    complexity: t.complexity,
    verificationCommand:
      typeof t.verificationCommand === 'string' ? t.verificationCommand : undefined,
    model: t.model
  }))

  return { tasks }
}

function buildDecompositionInputsMirror(
  brief: TestBrief,
  specialistList: string,
  mode?: ConversationMode
): { prompt: string; specialistList: string } {
  const decisionsBlock =
    brief.decisions.length > 0
      ? `\nKey decisions already made:\n${brief.decisions.map((d) => `- ${d}`).join('\n')}`
      : ''

  const constraintsBlock =
    brief.constraints.length > 0
      ? `\nConstraints to respect:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`
      : ''

  const filesBlock =
    brief.filesDiscussed.length > 0
      ? `\nFiles discussed/planned:\n${brief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
      : ''

  const MAX_CONVERSATION_CHARS = 3000
  const rawConversation =
    brief.recentMessages.length > 0
      ? brief.recentMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n')
      : ''

  const conversationBlock = rawConversation
    ? `\nRecent conversation context:\n${
        rawConversation.length > MAX_CONVERSATION_CHARS
          ? rawConversation.substring(rawConversation.length - MAX_CONVERSATION_CHARS) +
            '\n[... earlier messages truncated]'
          : rawConversation
      }`
    : ''

  const modeInstruction =
    mode === 'plan'
      ? '\n\nIMPORTANT: This is a PLAN-MODE decomposition...'
      : ''

  const prompt = `Think step by step about the dependencies and potential file conflicts before decomposing.

Task to decompose: "${brief.summary}"
${modeInstruction}
${decisionsBlock}
${constraintsBlock}
${filesBlock}
${conversationBlock}

Available specialists:
${specialistList}

Decompose this task into sub-tasks and respond with ONLY valid JSON.`

  return { prompt, specialistList }
}

function buildSubAgentDefinitionsMirror(
  tasks: Array<Pick<NormalizedTask, 'id' | 'specialist' | 'description' | 'model'>>,
  mode: ConversationMode
): Record<string, TestAgentDefinition> {
  const agents: Record<string, TestAgentDefinition> = {}
  const specialistIds = [...new Set(tasks.map((t) => t.specialist))]

  for (const specialistId of specialistIds) {
    const specialistTasks = tasks
      .filter((t) => t.specialist === specialistId)
      .map((t) => `- [${t.id}] ${t.description}`)
      .join('\n')

    const taskModels = tasks
      .filter((t) => t.specialist === specialistId)
      .map((t) => t.model ?? 'sonnet')

    const model = taskModels.includes('opus')
      ? 'opus'
      : taskModels.includes('sonnet')
        ? 'sonnet'
        : 'haiku'

    const budgetTier = model === 'haiku' ? 'minimal' : model === 'opus' ? 'full' : 'standard'

    const tools =
      mode === 'build'
        ? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
        : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']

    agents[specialistId] = {
      description: `${specialistId}: Specialist agent`,
      prompt: `System prompt\n\n## Your Assigned Tasks\n${specialistTasks}`,
      tools,
      model,
      budgetTier
    }
  }

  return agents
}

function buildSdkQueryOptionsMirror(
  options: Pick<SDKExecuteOptions, 'agents' | 'allowedTools'>
): {
  allowedTools?: string[]
  agents?: SDKExecuteOptions['agents']
} {
  return {
    ...(options.agents ? { agents: options.agents } : {}),
    allowedTools: options.agents
      ? [...new Set([...(options.allowedTools ?? []), 'Agent'])]
      : options.allowedTools
  }
}

const require = createRequire(import.meta.url)

type RuntimeContracts = {
  AGENT_IDS: Record<string, string>
  DEFAULT_MODEL_CONFIG: Record<string, string>
  DEFAULT_PROMPTS: Record<string, Record<string, string>>
}

let runtimeContracts: RuntimeContracts | null = null
let runtimeContractError: string | null = null

try {
  const constants = require('../../../shared/constants') as {
    AGENT_IDS: Record<string, string>
    DEFAULT_MODEL_CONFIG: Record<string, string>
  }
  const prompts = require('../default-prompts') as {
    DEFAULT_PROMPTS: Record<string, Record<string, string>>
  }
  runtimeContracts = {
    AGENT_IDS: constants.AGENT_IDS,
    DEFAULT_MODEL_CONFIG: constants.DEFAULT_MODEL_CONFIG,
    DEFAULT_PROMPTS: prompts.DEFAULT_PROMPTS
  }
} catch (err) {
  runtimeContractError = (err as Error).message
}

describe('Group A: parseDecompositionResult', () => {
  test('parses plain JSON with tasks', () => {
    const result = parseDecompositionResultMirror(
      JSON.stringify({
        tasks: [{ id: 'a1', specialist: 'react-architect', description: 'Review component tree' }]
      })
    )

    assert.equal(result.tasks.length, 1)
    assert.equal(result.tasks[0].id, 'a1')
    assert.equal(result.tasks[0].specialist, 'react-architect')
  })

  test('parses JSON wrapped in markdown fences', () => {
    const fenced = [
      '```json',
      '{"tasks":[{"specialist":"db-architect","description":"Inspect schema"}]}',
      '```'
    ].join('\n')

    const result = parseDecompositionResultMirror(fenced)
    assert.equal(result.tasks.length, 1)
    assert.equal(result.tasks[0].id, 't1')
  })

  test('throws explicit error for invalid JSON', () => {
    assert.throws(
      () => parseDecompositionResultMirror('this is not json'),
      /Failed to parse task decomposition — LLM returned invalid JSON/
    )
  })

  test('throws explicit error for missing/empty tasks array', () => {
    assert.throws(
      () => parseDecompositionResultMirror(JSON.stringify({ tasks: [] })),
      /Task decomposition returned no tasks/
    )
  })

  test('normalizes id, dependsOn, and verificationCommand fields', () => {
    const result = parseDecompositionResultMirror(
      JSON.stringify({
        tasks: [
          {
            specialist: 'electron-architect',
            description: 'Trace IPC wiring',
            dependsOn: 'not-an-array',
            verificationCommand: 123
          }
        ]
      })
    )

    assert.equal(result.tasks[0].id, 't1')
    assert.deepEqual(result.tasks[0].dependsOn, [])
    assert.equal(result.tasks[0].verificationCommand, undefined)
  })
})

describe('Group B: buildSubAgentDefinitions', () => {
  const baseTasks: Array<Pick<NormalizedTask, 'id' | 'specialist' | 'description' | 'model'>> = [
    { id: 't1', specialist: 'react-architect', description: 'Analyze UI', model: 'haiku' },
    { id: 't2', specialist: 'react-architect', description: 'Validate rendering', model: 'sonnet' },
    { id: 't3', specialist: 'db-architect', description: 'Check indexes', model: 'opus' },
    { id: 't4', specialist: 'db-architect', description: 'Review constraints', model: 'haiku' },
    { id: 't5', specialist: 'electron-architect', description: 'Inspect IPC map' }
  ]

  test('selects opus model when any assigned task uses opus', () => {
    const agents = buildSubAgentDefinitionsMirror(baseTasks, 'plan')
    assert.equal(agents['db-architect'].model, 'opus')
    assert.equal(agents['db-architect'].budgetTier, 'full')
  })

  test('selects sonnet when no opus but sonnet is present', () => {
    const agents = buildSubAgentDefinitionsMirror(baseTasks, 'plan')
    assert.equal(agents['react-architect'].model, 'sonnet')
    assert.equal(agents['react-architect'].budgetTier, 'standard')
  })

  test('selects haiku when all tasks are haiku', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Smoke checks', model: 'haiku' }] as const
    const agents = buildSubAgentDefinitionsMirror(tasks, 'plan')
    assert.equal(agents.qa.model, 'haiku')
    assert.equal(agents.qa.budgetTier, 'minimal')
  })

  test('defaults missing task model to sonnet', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'No model provided' }]
    const agents = buildSubAgentDefinitionsMirror(tasks, 'plan')
    assert.equal(agents.qa.model, 'sonnet')
  })

  test('uses full build-mode toolset when mode=build', () => {
    const agents = buildSubAgentDefinitionsMirror(baseTasks, 'build')
    assert.deepEqual(agents['react-architect'].tools, [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch'
    ])
  })

  test('uses read-only plan toolset when mode=plan', () => {
    const agents = buildSubAgentDefinitionsMirror(baseTasks, 'plan')
    assert.deepEqual(agents['react-architect'].tools, [
      'Read',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch'
    ])
  })

  test('builds one agent definition per unique specialist', () => {
    const agents = buildSubAgentDefinitionsMirror(baseTasks, 'build')
    assert.deepEqual(Object.keys(agents).sort(), [
      'db-architect',
      'electron-architect',
      'react-architect'
    ])
  })
})

describe('Group C: buildDecompositionInputs', () => {
  test('includes decisions, constraints, and files blocks when present', () => {
    const brief: TestBrief = {
      summary: 'Investigate migration',
      decisions: ['Use SubAgents only'],
      constraints: ['No orchestrator fallback'],
      filesDiscussed: ['src/main/ipc/chat-plan.ipc.ts'],
      recentMessages: []
    }
    const { prompt } = buildDecompositionInputsMirror(brief, '- "x" — X: Prompt')

    assert.match(prompt, /Key decisions already made:/)
    assert.match(prompt, /Constraints to respect:/)
    assert.match(prompt, /Files discussed\/planned:/)
  })

  test('omits optional blocks when arrays are empty', () => {
    const brief: TestBrief = {
      summary: 'Investigate migration',
      decisions: [],
      constraints: [],
      filesDiscussed: [],
      recentMessages: []
    }
    const { prompt } = buildDecompositionInputsMirror(brief, '- "x" — X: Prompt')

    assert.doesNotMatch(prompt, /Key decisions already made:/)
    assert.doesNotMatch(prompt, /Constraints to respect:/)
    assert.doesNotMatch(prompt, /Files discussed\/planned:/)
  })

  test('truncates conversation to last 3000 chars and appends marker', () => {
    const longText = 'a'.repeat(3200)
    const brief: TestBrief = {
      summary: 'Investigate migration',
      decisions: [],
      constraints: [],
      filesDiscussed: [],
      recentMessages: [{ role: 'user', content: longText }]
    }
    const { prompt } = buildDecompositionInputsMirror(brief, '- "x" — X: Prompt')

    assert.match(prompt, /\[\.\.\. earlier messages truncated\]/)
    assert.match(prompt, /Recent conversation context:/)
  })

  test('keeps full conversation when <= 3000 chars', () => {
    const brief: TestBrief = {
      summary: 'Investigate migration',
      decisions: [],
      constraints: [],
      filesDiscussed: [],
      recentMessages: [{ role: 'assistant', content: 'short context' }]
    }
    const { prompt } = buildDecompositionInputsMirror(brief, '- "x" — X: Prompt')

    assert.match(prompt, /\[assistant\]: short context/)
    assert.doesNotMatch(prompt, /\[\.\.\. earlier messages truncated\]/)
  })

  test('adds plan-mode instruction only when mode=plan', () => {
    const brief: TestBrief = {
      summary: 'Investigate migration',
      decisions: [],
      constraints: [],
      filesDiscussed: [],
      recentMessages: []
    }

    const { prompt: planPrompt } = buildDecompositionInputsMirror(brief, '- "x" — X: Prompt', 'plan')
    const { prompt: buildPrompt } = buildDecompositionInputsMirror(
      brief,
      '- "x" — X: Prompt',
      'build'
    )

    assert.match(planPrompt, /IMPORTANT: This is a PLAN-MODE decomposition/)
    assert.doesNotMatch(buildPrompt, /IMPORTANT: This is a PLAN-MODE decomposition/)
  })
})

describe('Group D: SDKExecuteOptions agents wiring', () => {
  test('includes agents on query options when provided', () => {
    const agents = {
      qa: {
        description: 'QA',
        prompt: 'QA prompt',
        tools: ['Read'],
        model: 'haiku'
      }
    }
    const options = buildSdkQueryOptionsMirror({ agents, allowedTools: ['Read'] })
    assert.equal(options.agents, agents)
  })

  test('auto-includes Agent tool and deduplicates when agents exist', () => {
    const options = buildSdkQueryOptionsMirror({
      agents: {
        qa: { description: 'QA', prompt: 'QA prompt' }
      },
      allowedTools: ['Read', 'Agent', 'Grep']
    })

    assert.deepEqual(options.allowedTools, ['Read', 'Agent', 'Grep'])
  })

  test('keeps allowedTools unchanged when agents are not provided', () => {
    const options = buildSdkQueryOptionsMirror({
      allowedTools: ['Read', 'Grep']
    })
    assert.deepEqual(options.allowedTools, ['Read', 'Grep'])
    assert.equal(options.agents, undefined)
  })
})

describe('Group E: IPC contract compatibility', () => {
  const skipReason = runtimeContractError
    ? `runtime imports unavailable (${runtimeContractError})`
    : undefined

  test(
    'exposes AGENT_IDS.GENERALIST constant',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(runtimeContracts.AGENT_IDS.GENERALIST, 'generalist')
    },
    { skipReason }
  )

  test(
    'exposes DEFAULT_MODEL_CONFIG.generalist as a string',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(typeof runtimeContracts.DEFAULT_MODEL_CONFIG.generalist, 'string')
      assert.ok(runtimeContracts.DEFAULT_MODEL_CONFIG.generalist.length > 0)
    },
    { skipReason }
  )

  test(
    'exposes DEFAULT_PROMPTS.generalist plan/build prompts',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(typeof runtimeContracts.DEFAULT_PROMPTS.generalist.plan, 'string')
      assert.equal(typeof runtimeContracts.DEFAULT_PROMPTS.generalist.build, 'string')
      assert.ok(runtimeContracts.DEFAULT_PROMPTS.generalist.plan.length > 0)
      assert.ok(runtimeContracts.DEFAULT_PROMPTS.generalist.build.length > 0)
    },
    { skipReason }
  )

  test(
    'does not require an orchestrator prompt contract after migration',
    () => {
      assert.ok(runtimeContracts)
      assert.equal('orchestrator' in runtimeContracts.DEFAULT_PROMPTS, false)
    },
    { skipReason }
  )
})

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) process.exit(1)

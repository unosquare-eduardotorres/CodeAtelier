import type { ConversationMode, DecomposedTask, HandoffBrief, TaskPlan } from '../../shared/types'
import type { SDKAgentDefinition } from './sdk-executor'

export const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/

const ACTION_VERB_PREFIX =
  /^(Fix|Implement|Create|Build|Rebuild|Deploy|Migrate|Refactor|Add|Update|Remove|Delete)\b/i

export function parseHandoffBlock(text: string): HandoffBrief | null {
  const match = text.match(HANDOFF_REGEX)
  if (!match) {
    return null
  }

  try {
    const parsed = JSON.parse(match[1].trim()) as {
      action?: string
      summary?: string
      decisions?: unknown
      constraints?: unknown
      filesDiscussed?: unknown
      specialists?: unknown
    }

    if (parsed.action !== 'handoff' || !parsed.summary) {
      return null
    }

    const brief: HandoffBrief = {
      summary: parsed.summary,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      filesDiscussed: Array.isArray(parsed.filesDiscussed) ? parsed.filesDiscussed : [],
      recentMessages: [],
      specialists: Array.isArray(parsed.specialists) ? parsed.specialists : [],
      mode: 'plan'
    }

    if (ACTION_VERB_PREFIX.test(brief.summary)) {
      brief.summary = brief.summary.replace(ACTION_VERB_PREFIX, 'Investigate')
    }

    return brief
  } catch {
    return null
  }
}

export function parseDecompositionResult(
  result: string,
  conversationId: string,
  brief: HandoffBrief,
  mode: ConversationMode,
  enrichFn?: (tasks: DecomposedTask[]) => DecomposedTask[]
): TaskPlan {
  let jsonStr = result
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  let parsed: { tasks?: Array<Partial<DecomposedTask>> }
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('Failed to parse task decomposition — LLM returned invalid JSON')
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'tasks') || !Array.isArray(parsed.tasks)) {
    throw new Error('Task decomposition response missing tasks array')
  }

  if (parsed.tasks.length === 0) {
    throw new Error('Task decomposition returned no tasks')
  }

  const normalizedTasks: DecomposedTask[] = parsed.tasks.map((task, index) => ({
    id: task.id || `t${index + 1}`,
    specialist: task.specialist as string,
    description: task.description as string,
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
    complexity: task.complexity,
    model: task.model,
    verificationCommand:
      typeof task.verificationCommand === 'string' ? task.verificationCommand : undefined
  }))

  const tasks = enrichFn ? enrichFn(normalizedTasks) : normalizedTasks

  return {
    conversationId,
    summary: brief.summary,
    mode,
    tasks,
    brief
  }
}

export function buildSubAgentDefinitions(
  tasks: DecomposedTask[],
  mode: ConversationMode,
  buildAgentConfig: (
    specialistId: string,
    tasks: DecomposedTask[],
    mode: ConversationMode
  ) => { systemPrompt: string; description: string }
): Record<string, SDKAgentDefinition> {
  const agents: Record<string, SDKAgentDefinition> = {}
  const specialistIds = [...new Set(tasks.map((task) => task.specialist))]

  for (const specialistId of specialistIds) {
    const specialistTasks = tasks.filter((task) => task.specialist === specialistId)
    const taskList = specialistTasks.map((task) => `- [${task.id}] ${task.description}`).join('\n')

    const taskModels = specialistTasks.map((task) => task.model ?? 'sonnet')
    const model: 'sonnet' | 'opus' | 'haiku' = taskModels.includes('opus')
      ? 'opus'
      : taskModels.includes('sonnet')
        ? 'sonnet'
        : 'haiku'

    const tools =
      mode === 'build'
        ? ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch']
        : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']

    const { systemPrompt, description } = buildAgentConfig(specialistId, specialistTasks, mode)

    agents[specialistId] = {
      description,
      prompt: `${systemPrompt}\n\n## Your Assigned Tasks\n${taskList}`,
      tools,
      model
    }
  }

  return agents
}

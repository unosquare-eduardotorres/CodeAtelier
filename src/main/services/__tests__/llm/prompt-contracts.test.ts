/**
 * Tier 1 LLM Tests: Decomposition Prompt → Parse Contracts
 *
 * These tests send real prompts to the LLM (Haiku) and verify that the output
 * parses correctly through our actual parsing functions.
 *
 * Cost: ~$0.05-0.10 per run
 */
import { parseDecompositionResult } from '../../generalist-utils'
import { DECOMPOSITION_SYSTEM_PROMPT } from '../../default-prompts'
import { SDKExecutor } from '../../sdk-executor'
import { MOCK_BRIEF } from '../fixtures/pipeline-fixtures'

import type { SDKExecuteOptions } from '../../sdk-executor'
import type { HandoffBrief } from '../../../../shared/types'

// ── Async test harness ──

let passed = 0
let failed = 0

async function testLLM(
  name: string,
  fn: (ac: AbortController) => Promise<void>,
  timeoutMs = 120_000
): Promise<void> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  try {
    await Promise.race([
      fn(ac),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort()
          reject(new Error(`Timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        if (timer.unref) timer.unref()
      })
    ])
    clearTimeout(timer!)
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    clearTimeout(timer!)
    ac.abort() // ensure cleanup even on non-timeout errors
    const message = (err as Error).message
    console.error(`  ✗ ${name}`)
    console.error(`    ${message}`)
    failed++
    if (message.includes('Timeout')) {
      await new Promise((r) => setTimeout(r, 2000)) // cooldown after timeout
    }
  }
}

async function withRetry(fn: () => Promise<void>, retries = 1): Promise<void> {
  for (let i = 0; i <= retries; i++) {
    try {
      await fn()
      return
    } catch (err) {
      if (i === retries) throw err
      console.log(`    ↻ Retrying (attempt ${i + 2}/${retries + 1})...`)
    }
  }
}

// ── Shared config ──

const executor = new SDKExecutor()

function baseOptions(ac?: AbortController): SDKExecuteOptions {
  return {
    model: 'haiku',
    cwd: process.cwd(),
    // Use 'default' instead of 'plan' to avoid SDK injecting ExitPlanMode built-in tool.
    // Tests verify prompt adherence, not SDK permission behavior.
    permissionMode: 'default' as const,
    allowedTools: [] as string[],
    // Keep disallowedTools as defense-in-depth in case SDK changes behavior
    disallowedTools: ['ExitPlanMode', 'ToolSearch'],
    maxTurns: 1,
    prompt: '', // overridden by caller
    systemPrompt: '', // overridden by caller
    heartbeatIntervalMs: 0, // suppress stall warnings in tests
    ...(ac ? { abortController: ac } : {})
  }
}

function buildDecompositionPrompt(brief: HandoffBrief, specialistList: string[]): string {
  return [
    `Task summary: ${brief.summary}`,
    `Decisions: ${brief.decisions.join(', ') || 'none'}`,
    `Constraints: ${brief.constraints.join(', ') || 'none'}`,
    `Files discussed: ${brief.filesDiscussed.join(', ') || 'none'}`,
    `Mode: ${brief.mode}`,
    `Available specialists: ${specialistList.join(', ')}`
  ].join('\n')
}

// ── Tests ──

async function run(): Promise<void> {
  console.log('Prompt contract tests (Tier 1 — Haiku)')

  const defaultSpecialists = ['dotnet-architect', 'testing-specialist', 'platform-architect']

  // Warmup — first SDK call through Claude CLI auth is slow (~30-60s).
  // Fire a cheap throwaway call so subsequent tests don't eat their timeout on cold start.
  console.log('  … warming up SDK (first call may take 30-60s)')
  {
    const warmupAc = new AbortController()
    let warmupTimer: ReturnType<typeof setTimeout>
    try {
      await Promise.race([
        executor.executeAndCollect({
          ...baseOptions(warmupAc),
          prompt: 'Reply with just the word "ok".',
          systemPrompt: 'You are a test assistant. Reply with just "ok".'
        }),
        new Promise<never>((_, reject) => {
          warmupTimer = setTimeout(() => {
            warmupAc.abort()
            reject(new Error('warmup timeout'))
          }, 120_000)
          if (warmupTimer.unref) warmupTimer.unref()
        })
      ])
      clearTimeout(warmupTimer!)
      console.log('  … warmup complete\n')
    } catch {
      clearTimeout(warmupTimer!)
      warmupAc.abort()
      console.log('  … warmup timed out — tests may be slow\n')
    }
  }

  await testLLM('decomposition prompt produces valid parseable JSON', (ac) =>
    withRetry(async () => {
      const prompt = buildDecompositionPrompt(MOCK_BRIEF, defaultSpecialists)
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
        prompt,
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT
      })

      const plan = parseDecompositionResult(result, 'test-conv-1', MOCK_BRIEF, 'plan')

      if (!plan.tasks || plan.tasks.length === 0) {
        throw new Error('Expected at least 1 task in the plan')
      }

      for (const task of plan.tasks) {
        if (!task.id) throw new Error(`Task missing id: ${JSON.stringify(task)}`)
        if (!task.specialist) throw new Error(`Task missing specialist: ${JSON.stringify(task)}`)
        if (!task.description) throw new Error(`Task missing description: ${JSON.stringify(task)}`)
        if (!Array.isArray(task.dependsOn))
          throw new Error(`Task missing dependsOn array: ${JSON.stringify(task)}`)
      }
    })
  )

  await testLLM('investigation input produces only investigation tasks', (ac) =>
    withRetry(async () => {
      const investigationBrief: HandoffBrief = {
        ...MOCK_BRIEF,
        summary: 'Investigate why auth token refresh fails silently'
      }
      const prompt = buildDecompositionPrompt(investigationBrief, defaultSpecialists)
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
        prompt,
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT
      })

      const plan = parseDecompositionResult(result, 'test-conv-2', investigationBrief, 'plan')

      for (const task of plan.tasks) {
        const desc = task.description.toLowerCase()
        if (!desc.includes('investigat')) {
          throw new Error(`Expected investigation task but got: "${task.description}"`)
        }
        if (/^(Fix|Implement|Test|Deploy)\b/i.test(task.description)) {
          throw new Error(
            `Investigation should not produce action tasks: "${task.description}"`
          )
        }
      }
    })
  )

  await testLLM('plan-mode decomposition never produces fix tasks', (ac) =>
    withRetry(async () => {
      const fixBrief: HandoffBrief = {
        ...MOCK_BRIEF,
        summary: 'Fix the login bug',
        mode: 'plan'
      }
      const prompt = buildDecompositionPrompt(fixBrief, defaultSpecialists)
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
        prompt,
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT
      })

      const plan = parseDecompositionResult(result, 'test-conv-3', fixBrief, 'plan')

      for (const task of plan.tasks) {
        if (/^(Fix|Implement|Rebuild)\b/i.test(task.description)) {
          throw new Error(
            `Plan-mode task should not start with action verb: "${task.description}"`
          )
        }
      }
    })
  )

  await testLLM('decomposition respects specialist list', (ac) =>
    withRetry(async () => {
      const singleSpecBrief: HandoffBrief = {
        ...MOCK_BRIEF,
        specialists: ['dotnet-architect']
      }
      const prompt = buildDecompositionPrompt(singleSpecBrief, ['dotnet-architect'])
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
        prompt,
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT
      })

      const plan = parseDecompositionResult(result, 'test-conv-4', singleSpecBrief, 'plan')

      for (const task of plan.tasks) {
        if (task.specialist !== 'dotnet-architect') {
          throw new Error(
            `Expected specialist "dotnet-architect" but got "${task.specialist}"`
          )
        }
      }
    })
  )

  await testLLM('decomposition includes complexity scoring', (ac) =>
    withRetry(async () => {
      const prompt = buildDecompositionPrompt(MOCK_BRIEF, defaultSpecialists)
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
        prompt,
        systemPrompt: DECOMPOSITION_SYSTEM_PROMPT
      })

      const plan = parseDecompositionResult(result, 'test-conv-5', MOCK_BRIEF, 'plan')

      for (const task of plan.tasks) {
        if (!task.complexity) {
          throw new Error(`Task "${task.id}" missing complexity object`)
        }
        if (typeof task.complexity.total !== 'number') {
          throw new Error(`Task "${task.id}" complexity.total is not a number`)
        }
        if (!['simple', 'moderate', 'complex'].includes(task.complexity.tier)) {
          throw new Error(
            `Task "${task.id}" complexity.tier is invalid: "${task.complexity.tier}"`
          )
        }
        for (const dim of [
          'filesAffected',
          'estimatedLines',
          'newDependencies',
          'taskType',
          'riskFlags'
        ] as const) {
          if (typeof task.complexity[dim] !== 'number') {
            throw new Error(`Task "${task.id}" complexity.${dim} is not a number`)
          }
        }
      }
    })
  )

  // ── Summary ──
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

export { run }

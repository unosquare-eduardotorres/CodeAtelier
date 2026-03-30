/**
 * Tier 2 LLM Tests: Generalist → Handoff Round-Trip
 *
 * Verify the generalist system prompt produces handoff blocks that our
 * parseHandoffBlock regex can parse, and that non-handoff questions
 * do NOT produce handoff blocks.
 *
 * Cost: ~$0.05-0.15 per run
 */
import { GENERALIST_BASE_PROMPT } from '../../default-prompts'
import { parseHandoffBlock } from '../../generalist-utils'
import { SDKExecutor } from '../../sdk-executor'

import type { SDKExecuteOptions } from '../../sdk-executor'

// ── Async test harness ──

let passed = 0
let failed = 0

async function testLLM(name: string, fn: () => Promise<void>, timeoutMs = 90_000): Promise<void> {
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ])
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
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

function baseOptions(): SDKExecuteOptions {
  return {
    model: 'haiku',
    cwd: process.cwd(),
    permissionMode: 'plan' as const,
    allowedTools: [] as string[],
    maxTurns: 1,
    prompt: '', // overridden by caller
    systemPrompt: '', // overridden by caller
    heartbeatIntervalMs: 0 // suppress stall warnings in tests
  }
}

// ── Tests ──

async function run(): Promise<void> {
  console.log('Handoff round-trip tests (Tier 2 — Haiku)')

  await testLLM('generalist produces parseable handoff for implementation request', () =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(),
        prompt:
          'I need you to fix the authentication bug in our token refresh module. Have a specialist look at this.',
        systemPrompt: GENERALIST_BASE_PROMPT
      })

      if (!result.includes('```handoff')) {
        throw new Error(
          `Expected response to contain \`\`\`handoff block but got:\n${result.slice(0, 300)}`
        )
      }

      const brief = parseHandoffBlock(result)
      if (!brief) {
        throw new Error('parseHandoffBlock returned null — handoff block did not parse')
      }
      if (!Array.isArray(brief.specialists) || brief.specialists.length === 0) {
        throw new Error('Parsed handoff missing specialists array')
      }
      if (!brief.summary) {
        throw new Error('Parsed handoff missing summary')
      }
    })
  )

  await testLLM('handoff mode is always forced to plan', () =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(),
        prompt:
          'Build the new payment integration from scratch. Delegate this to a specialist in build mode.',
        systemPrompt: GENERALIST_BASE_PROMPT
      })

      const brief = parseHandoffBlock(result)
      if (!brief) {
        throw new Error('parseHandoffBlock returned null — expected handoff block in response')
      }
      if (brief.mode !== 'plan') {
        throw new Error(`Expected mode "plan" but got "${brief.mode}"`)
      }
    })
  )

  await testLLM('non-implementation question does NOT produce handoff', () =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(),
        prompt:
          'What is the difference between a mutex and a semaphore? Explain briefly with examples.',
        systemPrompt: GENERALIST_BASE_PROMPT
      })

      const brief = parseHandoffBlock(result)
      if (brief !== null) {
        throw new Error(
          `Expected no handoff for a pure question, but parseHandoffBlock returned: ${JSON.stringify(brief)}`
        )
      }
    })
  )

  // ── Summary ──
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

export { run }

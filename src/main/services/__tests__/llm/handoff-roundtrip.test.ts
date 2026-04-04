/**
 * Tier 2 LLM Tests: Generalist → Handoff Round-Trip
 *
 * Verify the generalist system prompt produces handoff blocks that our
 * parseHandoffBlock regex can parse, and that non-handoff questions
 * do NOT produce handoff blocks.
 *
 * Cost: ~$0.05-0.15 per run
 */
import { GENERALIST_BASE_PROMPT, GENERALIST_PLAN_MODE_SECTION } from '../../default-prompts'
import { parseHandoffBlock } from '../../generalist-utils'
import { SDKExecutor } from '../../sdk-executor'

import type { SDKExecuteOptions } from '../../sdk-executor'

// ── Async test harness ──

let passed = 0
let failed = 0

async function testLLM(
  name: string,
  fn: (ac: AbortController) => Promise<void>,
  timeoutMs = 90_000
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
    permissionMode: 'plan' as const,
    allowedTools: [] as string[],
    maxTurns: 1,
    prompt: '', // overridden by caller
    systemPrompt: '', // overridden by caller
    heartbeatIntervalMs: 0, // suppress stall warnings in tests
    ...(ac ? { abortController: ac } : {})
  }
}

// ── Tests ──

async function run(): Promise<void> {
  console.log('Handoff round-trip tests (Tier 2 — Haiku)')

  await testLLM('generalist produces parseable handoff for implementation request', (ac) =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
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

  await testLLM('handoff mode is always forced to plan', (ac) =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
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

  await testLLM('non-implementation question does NOT produce handoff', (ac) =>
    withRetry(async () => {
      const { result } = await executor.executeAndCollect({
        ...baseOptions(ac),
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

  await testLLM(
    'plan request produces ````plan block not file write',
    (ac) =>
      withRetry(async () => {
        const { result } = await executor.executeAndCollect({
          ...baseOptions(ac),
          prompt:
            'Create an implementation plan for adding a user settings page with dark mode toggle and notification preferences.',
          systemPrompt: GENERALIST_BASE_PROMPT + '\n' + GENERALIST_PLAN_MODE_SECTION
        })

        // Should contain a plan block
        const planMatch = result.match(/`{3,4}plan\n([\s\S]*?)`{3,4}/)
        if (!planMatch) {
          // Check if the LLM tried to write a file instead
          if (result.includes('blocked') || result.includes('file path')) {
            throw new Error(
              'LLM tried to write plan to file instead of emitting ````plan block. Prompt adherence failure.'
            )
          }
          throw new Error(
            `Expected \`\`\`\`plan block in response but got:\n${result.slice(0, 500)}`
          )
        }

        // Verify the plan content is valid JSON with expected structure
        try {
          const parsed = JSON.parse(planMatch[1].trim())
          if (!parsed.title) throw new Error('Plan missing "title" field')
          if (!Array.isArray(parsed.sections) && !Array.isArray(parsed.steps)) {
            throw new Error('Plan missing both "sections" and "steps" arrays')
          }
        } catch (err) {
          if ((err as Error).message.includes('Plan missing')) throw err
          throw new Error(`Plan block contains invalid JSON: ${(err as Error).message}`)
        }
      }),
    180_000
  )

  // ── Summary ──
  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

export { run }

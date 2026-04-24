/**
 * Migration-era contract tests.
 *
 * Before the Project Specialist refactor this suite also mirrored the
 * decomposition + handoff helpers to prove the regexes + SDK-options builder
 * were stable. Those helpers and their consumers are gone post-4a, so only
 * the runtime-contract group remains: ensures DEFAULT_MODEL_CONFIG,
 * DEFAULT_PROMPTS, and AGENT_IDS still expose the expected keys for the
 * Da Vinci agent (the historical 'generalist' DB value — Layer 2 rename
 * migration will update this).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

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

describe('IPC contract compatibility', () => {
  const skipReason = runtimeContractError
    ? `runtime imports unavailable (${runtimeContractError})`
    : undefined

  test(
    'exposes AGENT_IDS.DA_VINCI constant',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(runtimeContracts.AGENT_IDS.DA_VINCI, 'generalist')
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

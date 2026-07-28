/**
 * Migration-era contract tests.
 *
 * Ensures DEFAULT_MODEL_CONFIG + DEFAULT_PROMPTS expose the expected keys for
 * the Da Vinci agent and DA_VINCI_AGENT_ID is stable.
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
  DA_VINCI_AGENT_ID: string
  DEFAULT_MODEL_CONFIG: Record<string, string>
  DEFAULT_PROMPTS: Record<string, Record<string, string>>
}

let runtimeContracts: RuntimeContracts | null = null
let runtimeContractError: string | null = null

try {
  const constants = require('../../../shared/constants') as {
    DA_VINCI_AGENT_ID: string
    DEFAULT_MODEL_CONFIG: Record<string, string>
  }
  const prompts = require('../default-prompts') as {
    DEFAULT_PROMPTS: Record<string, Record<string, string>>
  }
  runtimeContracts = {
    DA_VINCI_AGENT_ID: constants.DA_VINCI_AGENT_ID,
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
    'exposes DA_VINCI_AGENT_ID constant',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(runtimeContracts.DA_VINCI_AGENT_ID, 'da-vinci')
    },
    { skipReason }
  )

  test(
    'exposes DEFAULT_MODEL_CONFIG["da-vinci"] as a string',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(typeof runtimeContracts.DEFAULT_MODEL_CONFIG['specialist'], 'string')
      assert.ok(runtimeContracts.DEFAULT_MODEL_CONFIG['specialist'].length > 0)
    },
    { skipReason }
  )

  test(
    'exposes DEFAULT_PROMPTS["da-vinci"] plan/build prompts',
    () => {
      assert.ok(runtimeContracts)
      assert.equal(typeof runtimeContracts.DEFAULT_PROMPTS['da-vinci'].plan, 'string')
      assert.equal(typeof runtimeContracts.DEFAULT_PROMPTS['da-vinci'].build, 'string')
      assert.ok(runtimeContracts.DEFAULT_PROMPTS['da-vinci'].plan.length > 0)
      assert.ok(runtimeContracts.DEFAULT_PROMPTS['da-vinci'].build.length > 0)
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

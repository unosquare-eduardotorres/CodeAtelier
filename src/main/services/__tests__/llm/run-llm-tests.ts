// LLM test runner (costs money — opt-in only)
// Run: npx tsx src/main/services/__tests__/llm/run-llm-tests.ts
// Or:  npm run test:llm

import { execSync } from 'node:child_process'

function isClaudeCliAvailable(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

if (!process.env.ANTHROPIC_API_KEY && !isClaudeCliAvailable()) {
  console.error(
    '⚠️  LLM tests require authentication. Set ANTHROPIC_API_KEY or ensure Claude CLI is installed and logged in.'
  )
  process.exit(1)
}

console.log('🤖 Running LLM test suite (costs ~$0.10-0.25 per run)\n')

async function main(): Promise<void> {
  const { run: runPromptContracts } = await import('./prompt-contracts.test')
  await runPromptContracts()

  const { run: runHandoffRoundtrip } = await import('./handoff-roundtrip.test')
  await runHandoffRoundtrip()
}

main()

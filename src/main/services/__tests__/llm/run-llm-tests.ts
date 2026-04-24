// LLM test runner (costs money — opt-in only)
// Run: npx tsx src/main/services/__tests__/llm/run-llm-tests.ts
// Or:  npm run test:llm
//
// Post-migration-66: all LLM tests in this directory tested the removed
// decomposition/handoff flows. The runner is retained for future LLM
// contract tests (Project Specialist prompt quality, skill activation
// correctness, etc.) but is currently a no-op.

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

console.log('🤖 LLM test suite — currently empty (handoff/decomposition tests removed).')
process.exit(0)

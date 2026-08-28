import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './e2e/test-results',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.e2e.ts'
    },
    {
      name: 'electron-live',
      // Live-LLM specs: *-live.e2e.ts by convention, plus the dual-mode
      // clarify-flow spec (shim or live, gated by env inside the spec).
      testMatch: ['**/*-live.e2e.ts', '**/blueprint-clarify-flow.e2e.ts'],
      timeout: 900_000 // 15 min — real LLM needs time
    }
  ]
})

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
      testMatch: '**/*.e2e.ts',
      // F4 (2.3) — live-LLM specs need LIVE_LLM=1 AND a cloud provider AND up
      // to 15 minutes; including them in the default project meant every
      // local/every-run invocation loaded them just to skip. The dedicated
      // `electron-live` project below owns them.
      testIgnore: '**/*-live.e2e.ts'
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

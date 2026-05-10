# Code Atelier — Test Suite

## Quick Start

```bash
# Run all unit tests (services)
npm run test:unit

# Run repository tests
npm run test:repo

# Run LLM integration tests (requires active Claude CLI session)
npm run test:llm

# Run all suites
npm run test:all
```

## Test Architecture

### Runner

Code Atelier uses a **custom tsx-based test runner** (no Jest/Vitest). Tests use:
- `node:assert/strict` for assertions
- A shared `test-harness.ts` providing `test()`, `describe()`, `summary()`
- Manual fakes/stubs for mocking (no framework)

### File Layout

```
src/main/services/__tests__/
├── run-tests.ts              # Main test runner (imports all registered tests)
├── test-harness.ts           # Shared test/describe/summary helpers
├── helpers/
│   ├── claude-mock.ts        # ScriptedClaudeClient — mock SDK execute interface
│   └── agent-factory.ts      # Service factories with injected dependencies
├── fixtures/
│   ├── mock-factory.ts       # Mock BrowserWindow, GeneralistService, repositories
│   ├── pipeline-fixtures.ts  # Pipeline test data
│   └── sample.ts             # Sample code for testing
├── *.test.ts                 # Unit test files
└── llm/
    ├── run-llm-tests.ts      # LLM test runner
    ├── prompt-contracts.test.ts
    └── handoff-roundtrip.test.ts

src/main/db/repositories/__tests__/
└── run-tests.ts              # Repository test runner

e2e/
├── *.e2e.ts                  # Playwright E2E tests
└── capture-screenshots.ts    # Screenshot utility
```

### Writing a New Test

1. Create `src/main/services/__tests__/<name>.test.ts`
2. Import the harness and assert:
   ```typescript
   import assert from 'node:assert/strict'
   import { test, describe } from './test-harness'
   ```
3. Write tests using AAA pattern:
   ```typescript
   describe('MyService', () => {
     test('does_something_correctly', () => {
       // Arrange
       const service = new MyService(mockDeps)
       // Act
       const result = service.doThing()
       // Assert
       assert.equal(result, expected)
     })
   })
   ```
4. Register in `run-tests.ts`:
   ```typescript
   import './<name>.test'
   ```
5. **Important**: Only the LAST imported file should call `summary()`. If adding mid-file, ensure `summary()` remains at the end.

### Using Test Helpers

#### ScriptedClaudeClient (claude-mock.ts)
```typescript
import { ScriptedClaudeClient, createTextOnlyClient } from './helpers/claude-mock'

// Simple text response
const client = createTextOnlyClient('Hello!')
const msg = await client.execute('test prompt')

// Multi-step with tool calls
const client = new ScriptedClaudeClient([
  { type: 'text', content: 'Let me check...' },
  { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
  { type: 'tool_result', content: 'file contents' },
  { type: 'text', content: 'Done!' }
])
```

#### Service Factories (agent-factory.ts)
```typescript
import { createConversationStateMachine, createIntentRouter } from './helpers/agent-factory'

// Fresh state machine with mock window
const { stateMachine, stateChanges, sentMessages } = createConversationStateMachine()

// Intent router that captures IPC sends
const { router, sentMessages } = createIntentRouter()
```

### Conventions

- **No network calls** — mock all external dependencies
- **No filesystem access** — use in-memory fakes for repos/file services
- **Fresh state per test** — never share mutable state between tests
- **Descriptive names** — use `snake_case` test names describing behavior
- **One assertion focus** — each test verifies one behavior (multiple asserts OK if same concern)

## Coverage Tracking

See `tests/_meta/discovery.md` for the full coverage gap analysis and prioritized test plan.
See `tests/_meta/CHANGELOG.md` for run-by-run progress log.

## Coverage

Real line / branch / function coverage is produced by [`c8`](https://github.com/bcoe/c8),
which sits on top of Node.js's built-in V8 coverage and uses `tsx` as a Node `--import`
loader so TypeScript source files appear in the report (no test-runner migration needed).

> **Why `node --import tsx` and not `tsx ...`?** Modern `tsx` (v4.3+) loads transformed
> modules in a way V8 coverage doesn't track as filesystem URLs, so `c8 tsx ...` reports
> 0% across the board. The `node --import tsx --enable-source-maps` form keeps source
> maps intact and produces real per-file coverage.

### Run coverage

```bash
# Run the full unified suite (services + IPC + repositories) under c8
npm run test:cov

# Same, but force the HTML reporter even if the default reporter list changes
npm run test:cov:html

# Run with thresholds (fails CI if coverage drops below the floor)
npm run test:cov:check
```

### Where to find the report

| Output | Path | Use |
|---|---|---|
| Clickable HTML report | `coverage/index.html` | Open in a browser to drill file-by-file |
| LCOV file | `coverage/lcov.info` | VS Code Coverage Gutters, Codecov, SonarQube |
| Console summary | stdout | Per-file table + overall totals |
| JSON summary | `coverage/coverage-summary.json` | Programmatic / CI consumption |

### Configuration

- **`.c8rc.json`** — include / exclude rules and reporter list. Note `"all": true`
  so untested files appear in the report at 0% (otherwise c8 only counts files
  loaded by the test run, hiding the real gap).
- **`src/main/__tests__/run-all.ts`** — single entrypoint that imports every
  registered test file (services, IPC, repositories) so one c8 run covers the
  whole suite. `npm run test:unit` and `npm run test:repo` keep their existing
  standalone entrypoints.

### Current baseline (April 2026)

First measured run via `npm run test:cov`:

| Metric | % | Notes |
|---|---:|---|
| Lines | **15.75%** | Pulled down by 0% renderer (components / stores / hooks) |
| Branches | **70.22%** | High because branches are mostly inside well-tested service logic |
| Functions | **46.75%** | ~half of all functions are exercised by the existing suite |
| Statements | **15.75%** | Tracks lines |

Per-area highlights (from the same run):

| Area | Lines % |
|---|---:|
| `src/main/db` | 81.57% |
| `src/main/services/role-adapters` | 54.00% |
| `src/main/db/repositories` | 40.60% |
| `src/main/services` (overall) | 34.23% |
| `src/main/services/sdk-executor` | 27.95% |
| `src/main/ipc` | 6.41% |
| `src/renderer/**` | 0.00% (all subtrees) |
| `src/shared/constants.ts` | 99.86% |

### Thresholds

The current `test:cov:check` floor is **lines 30 / functions 30 / branches 25**.
**Lines is below the floor today (15.75% < 30%)**, so the gate fails until either
(a) renderer / IPC tests are added or (b) the threshold is lowered while a test
plan is built. Branches and functions both clear the floor.

Recommended next moves (out of scope for this change):
1. Drop `lines` to ~15 / `functions` to ~45 / `branches` to ~70 to "lock in"
   today's baseline as a no-regression gate, then ratchet up.
2. Wire `test:cov:check` into CI once the threshold matches reality.
3. Add jsdom + a thin component-test harness to start chipping at the 0%
   renderer subtree.

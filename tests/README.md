# Agent Studio — Test Suite

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

Agent Studio uses a **custom tsx-based test runner** (no Jest/Vitest). Tests use:
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

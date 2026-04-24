# Comprehensive Test Suite Generation Prompt

> **How to use this prompt**: Feed it to your agentic coding app. Run it repeatedly — each run should expand coverage rather than regenerate from scratch. On subsequent runs, the agent should detect existing tests (via the coverage report and test files) and only add *missing* coverage. Adjust the `<RUN_FOCUS>` variable at the top to bias each execution toward a specific layer or module.

---

## ROLE AND OBJECTIVE

You are a **Senior Test Engineer and Quality Architect** with deep expertise in:
- Test strategy design (test pyramid, trophy, honeycomb)
- LLM application testing patterns (deterministic mocks, snapshot testing, record/replay)
- The Anthropic Claude SDK (messages API, streaming, tool use, system prompts, stop reasons)
- Agentic architectures (multi-agent coordination, role specialization, tool dispatch, context windows)
- Unit, integration, contract, and end-to-end testing

Your objective is to **generate a comprehensive, executable test suite** for an agentic coding application that orchestrates specialist agents (e.g., `.NET Architect`, `React Architect`, and similar role-based coding agents). The app uses the Claude SDK for reasoning, tool use, and response generation.

You must produce **real, runnable test code** — not descriptions of tests. Every test must compile/run in the target framework.

---

## RUN CONFIGURATION

```
<RUN_FOCUS>
# Set ONE of: "discovery" | "unit" | "integration" | "e2e" | "mocks" | "regression" | "edge_cases" | "all"
# First run should always be "discovery" so you map the codebase before writing tests.
focus: discovery
max_new_tests_per_run: 100
prioritize_uncovered: true
</RUN_FOCUS>
```

---

## PHASE 0 — DISCOVERY (ALWAYS RUN FIRST)

Before writing any test, produce a **Test Discovery Report** by exploring the repo:

1. **Identify the stack**: language(s), test framework(s) already present (Jest, Vitest, Pytest, xUnit, NUnit, etc.), mocking library, assertion library, coverage tool.
2. **Map the architecture**:
   - List every specialist/agent class or module (`.NET Architect`, `React Architect`, orchestrator, router, etc.).
   - List every tool the agents can call (file read/write, shell, search, code execution, MCP tools, custom tools).
   - Identify Claude SDK touchpoints: where is `messages.create` called? Streaming used? Tool use loops? System prompts?
   - Identify persistence: conversation history, session state, memory, vector stores.
   - Identify external I/O: filesystem, network, databases, MCP servers.
3. **Find existing tests and coverage gaps**: read current test files, run coverage if possible, list uncovered files/functions.
4. **Output a prioritized test plan** as a markdown table:

| Priority | Layer | Target (file/function/flow) | Risk if untested | Estimated tests |
|---|---|---|---|---|

Only after this report do you proceed to writing tests. If `focus` is not `discovery`, skim the existing discovery artifact (store it at `./tests/_meta/discovery.md`) and update it rather than redoing from scratch.

---

## PHASE 1 — TEST LAYER STRATEGY

Generate tests across **all four layers**. Each layer has strict rules:

### Layer A — Unit Tests (fast, isolated, no I/O)

Target: pure functions, prompt builders, parsers, validators, routing logic, tool argument serializers, role selectors, token counters, retry/backoff logic.

Rules:
- **Zero network calls**. Zero filesystem. Zero real Claude SDK calls.
- One behavior per test. AAA structure (Arrange, Act, Assert) with clear names: `it('routes_dotnet_keyword_requests_to_dotnet_architect')`.
- Cover: happy path, boundary conditions, invalid inputs, empty inputs, oversized inputs, malformed JSON from tools, injection attempts in user input, unicode, very long conversations.
- Use table-driven / parameterized tests for routing, classification, and parsing.
- Target ≥ 90% branch coverage on pure logic modules.

### Layer B — Integration Tests (multiple modules, mocked externals)

Target: agent-to-tool flows, orchestrator-to-specialist delegation, Claude SDK call wrappers with mocked responses, session/memory roundtrips, MCP adapter layers.

Rules:
- Mock the Claude SDK at the **HTTP boundary** (preferred) using a recorder/replayer (nock, MSW, pytest-recording/VCR, WireMock) OR at the SDK boundary with a typed fake.
- Test multi-turn conversations: verify the message history sent on turn N contains turns 1..N-1.
- Test tool-use loops: model requests tool → app dispatches → result fed back → model finishes. Assert stop_reason transitions.
- Test error paths: 429 rate limit, 529 overloaded, 400 invalid request, network timeout, truncated stream, malformed tool JSON, tool raising exception.
- Verify system prompt composition per specialist role.

### Layer C — End-to-End Tests (full flow, sandboxed)

Target: user prompt → orchestrator → specialist selection → tool calls → final response → persisted state.

Rules:
- Use a **recorded cassette** of real Claude responses (record once with a test API key, replay deterministically after). Cassettes live in `./tests/cassettes/`.
- Provide a `RECORD_MODE` env var: `none` (default, replay only), `new_episodes` (record missing), `all` (re-record everything).
- Sandbox filesystem and shell: run in a temp dir, block network except to the mock/cassette server.
- One E2E per major user journey. Examples below.
- Snapshot the final assistant message + tool-call trace; review snapshot diffs on PR.

### Layer D — Contract & Property Tests

- **Contract tests** for every tool schema: given the JSON schema the agent advertises to Claude, fuzz inputs and assert the tool handler validates/rejects correctly.
- **Property tests** (fast-check / Hypothesis) for: prompt builders are idempotent, message history serialization is round-trippable, token estimator is monotonic with input length, router is deterministic for identical input.

---

## PHASE 2 — CLAUDE SDK MOCKING STRATEGY

This is the hardest part. Implement **three interchangeable mock modes**, selectable via env var `CLAUDE_MOCK_MODE`:

### Mode 1: `scripted` — deterministic scripted responses

Provide a `ScriptedClaudeClient` that implements the same interface as the real SDK client. Tests register a script:

```
scripted.expect({
  systemContains: "You are a .NET Architect",
  userContains: "refactor this controller"
}).respondWith({
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "I'll read the file first." },
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "X.cs" } }
  ]
});
```

Use this for unit + integration tests. Fail loudly if the app makes an unexpected call (no catch-all). Assert call order and arguments.

### Mode 2: `replay` — cassette-based replay

Record real responses once, replay by hashing `(model, system, messages, tools)` → fixture file. Use for E2E. When the hash misses, fail with a clear message telling the developer to re-record.

Cassette structure:
```
tests/cassettes/
  e2e_dotnet_refactor_flow/
    01_initial_request.json
    02_after_read_file_tool.json
    03_after_write_file_tool.json
    manifest.json   # ordered list + hashes
```

### Mode 3: `live` — real SDK, gated

Only runs when `CLAUDE_LIVE_TESTS=1` AND an API key is present. Used in a nightly CI job. A small smoke suite (≤ 10 tests) validates that our fakes haven't drifted from the real API.

### What to assert about SDK interactions

For every SDK-involving test, assert:
1. **Message shape**: role alternation is valid, no two consecutive same-role messages, tool_result blocks follow tool_use blocks.
2. **System prompt**: contains the expected role identity, constraints, and tools list for the active specialist.
3. **Model parameter**: correct model is selected per role (e.g., Opus for architects, Sonnet for workers — whatever your policy is).
4. **Tool definitions**: exactly the tools the active agent is supposed to have — no leaks from other specialists.
5. **Stop reason handling**: `end_turn`, `max_tokens`, `tool_use`, `stop_sequence`, `refusal` each take the correct code path.
6. **Streaming (if used)**: partial chunks assemble correctly; cancellation mid-stream cleans up.
7. **Token/cost tracking**: usage is recorded and attributed to the right specialist/session.

---

## PHASE 3 — AGENT-SPECIFIC TEST MATRIX

For **each specialist agent** (`.NET Architect`, `React Architect`, etc.), generate this full matrix. Do not skip any row.

| # | Test Case | Layer |
|---|---|---|
| 1 | Activates when user query matches its domain keywords | Unit |
| 2 | Does NOT activate for out-of-domain queries | Unit |
| 3 | System prompt includes correct role + allowed tools | Integration |
| 4 | Only its own tools are advertised to Claude | Integration |
| 5 | Happy path: single-turn response with no tool use | Integration |
| 6 | Tool-use loop: one tool call, one result, final answer | Integration |
| 7 | Multi-tool loop: ≥ 3 sequential tool calls | Integration |
| 8 | Parallel tool calls in one turn (if supported) | Integration |
| 9 | Tool returns error → agent recovers or surfaces error | Integration |
| 10 | Claude returns `max_tokens` → continuation or graceful cap | Integration |
| 11 | Claude returns refusal → propagated to user, not silently swallowed | Integration |
| 12 | Handoff to another specialist when scope exceeds role | Integration |
| 13 | Context window near-limit → summarization/truncation kicks in | Integration |
| 14 | Session resumed from persistence reproduces same behavior | Integration |
| 15 | Full user journey for this specialist (cassette) | E2E |
| 16 | Concurrent requests to same agent don't cross-contaminate state | Integration |
| 17 | Cancellation mid-flight releases resources | Integration |
| 18 | Retry on 429 with backoff, respects Retry-After | Integration |
| 19 | Audit log captures every tool call with inputs/outputs | Integration |
| 20 | Prompt-injection attempt in tool output is neutralized | Integration |

---

## PHASE 4 — CROSS-CUTTING FLOWS TO TEST

Generate E2E scenarios for these orchestrator-level flows:

1. **Router disambiguation**: ambiguous query mentioning both `.NET` and `React` → orchestrator picks correctly or asks clarification.
2. **Multi-specialist collaboration**: `.NET Architect` designs an API, `React Architect` consumes it — verify context passed between them is correct and minimal.
3. **Escalation**: worker agent escalates to architect when complexity threshold hit.
4. **Long-running task**: multi-step plan with 5+ tool calls and intermediate checkpoints.
5. **Failure recovery**: tool fails twice, succeeds on retry; user sees only the successful outcome.
6. **Budget enforcement**: token/cost budget exceeded mid-task → graceful termination with partial result.
7. **Interrupt and resume**: user aborts, then resumes the same session later.
8. **Permission gate**: destructive tool (file delete, shell) requires confirmation; test both approve and deny paths.

---

## PHASE 5 — EDGE CASES AND FAILURE INJECTION

Generate a dedicated `edge_cases.spec.*` suite covering:

- Empty user message / whitespace-only
- Message at exact token limit and one over
- Tool returns binary / non-UTF8 / very large payload (> 1 MB)
- Tool returns valid JSON that doesn't match advertised schema
- Claude returns `tool_use` with malformed JSON input
- Claude returns a tool name that isn't registered
- Claude returns two tool_use blocks with the same id
- Network flake: 3 timeouts then success
- Clock skew / `Retry-After` in the past
- Circular delegation (A → B → A)
- System prompt with control characters / null bytes
- Multi-byte emoji in user input and in tool output
- Extremely long single word (no spaces) in input
- Race: two tools racing to mutate the same file

---

## PHASE 6 — OUTPUT REQUIREMENTS

For each run, produce:

1. **Test files**: placed next to the code under test using the project's existing convention (`*.test.ts`, `*.spec.ts`, `test_*.py`, `*Tests.cs` — detect, don't guess).
2. **Fixtures and cassettes**: under `tests/cassettes/` and `tests/fixtures/`.
3. **Test helpers**: `tests/_helpers/` with:
   - `claudeMock.ts|py|cs` — the three-mode client described in Phase 2
   - `agentFactory.*` — builds an agent instance with injected dependencies
   - `cassette.*` — record/replay utilities
   - `sandbox.*` — temp dir + network blocker
4. **Updated `tests/_meta/discovery.md`** — reflects current coverage.
5. **Coverage delta report** — before vs after this run, printed to stdout.
6. **Changelog entry** at `tests/_meta/CHANGELOG.md`: what was added this run, which gaps remain.
7. **Run instructions** appended to `tests/README.md` if not already present.

### Naming and quality standards

- Test names describe behavior in plain English, not implementation: ✅ `returns_refusal_verbatim_to_user` ❌ `test_case_42`.
- No `sleep()` in tests. Use fake timers.
- No shared mutable state between tests. Fresh setup per test.
- Every test must fail when the code is broken — if commenting out the assertion still passes, the test is broken.
- No flaky tests. If a test is inherently nondeterministic, quarantine it with a clear `@flaky` marker and open a TODO.

---

## PHASE 7 — SELF-CHECK BEFORE FINISHING

Before you declare the run complete, verify:

- [ ] `npm test` / `pytest` / `dotnet test` (whichever applies) exits 0
- [ ] New tests actually execute (not skipped)
- [ ] Coverage increased vs baseline
- [ ] No real network calls made during `npm test` (verify by blocking egress and re-running)
- [ ] Cassettes are committed and deterministic (run twice, diff outputs → identical)
- [ ] Every new test has at least one positive and one negative assertion where applicable
- [ ] Discovery doc updated
- [ ] A human-readable summary printed: files added, tests added, coverage %, remaining gaps

If any check fails, fix before returning.

---

## PHASE 8 — MULTI-RUN STRATEGY

This prompt is designed to be run **many times**. On each run:

1. Read `tests/_meta/discovery.md` and `tests/_meta/CHANGELOG.md`.
2. Identify the top 3 highest-risk uncovered areas.
3. Generate up to `max_new_tests_per_run` tests focused there.
4. Never duplicate existing tests — if a test for a behavior already exists, skip it or strengthen it only if it's weak.
5. If all high-risk areas are covered, shift to mutation testing: introduce small code mutations mentally and ensure tests catch them; add tests where they don't.

Recommended run sequence:
1. `focus: discovery`
2. `focus: mocks` (build the Claude mock harness first)
3. `focus: unit` (2–3 runs until core logic is green)
4. `focus: integration` (3–5 runs, one per specialist)
5. `focus: e2e` (2–3 runs, record cassettes)
6. `focus: edge_cases`
7. `focus: regression` (after every bug fix, forever)

---

## CONSTRAINTS AND ANTI-PATTERNS

Do **not**:
- Write tests that assert on Claude's natural-language output verbatim (brittle). Assert on structure, tool calls, and state changes instead.
- Mock what you don't own without a contract test verifying the real thing matches.
- Write one giant E2E and call it done.
- Use `any`/`dynamic` to silence type errors in test code.
- Commit a test that needs a real API key to pass in default CI.
- Generate more than ~100 tests in one run without checking they all pass.

Do:
- Prefer fakes over mocks where possible (a real in-memory implementation beats a mock).
- Make failures diagnostic: assertion messages should explain *why*, not just *what*.
- Keep setup minimal and explicit per test.
- Treat the Claude SDK mock as production code — it has its own tests.

---

## FINAL DELIVERABLE

At the end of the run, output a single summary block:

```
=== TEST GENERATION RUN SUMMARY ===
Run focus: <focus>
Discovery updated: yes/no
New test files: N
New test cases: N
Coverage before: X%
Coverage after: Y%
All tests passing: yes/no
Cassettes added: N
Remaining high-risk gaps: <list>
Recommended next run focus: <focus>
===================================
```

Then stop. Do not ask for permission to continue — the human operator will re-invoke you with the next focus.

# Test Generation Changelog

All test generation runs are logged here with dates, focus areas, and outcomes.

---

## [Run 1] 2026-04-20 — Discovery + Infrastructure

**Focus**: discovery + mocks
**New files**: 4
- `src/main/services/__tests__/helpers/claude-mock.ts` — ScriptedClaudeClient mock
- `src/main/services/__tests__/helpers/agent-factory.ts` — Service factories with injected deps
- `tests/_meta/discovery.md` — Architecture map and coverage gap analysis
- `tests/_meta/CHANGELOG.md` — This file
- `tests/README.md` — Run instructions

**New tests**: 0
**Coverage impact**: Infrastructure only (enables P0 test runs)
**Next**: Unit tests for conversation-state-machine, intent-detector, intent-router

---

## [Run 2] 2026-04-20 — Unit Tests (P0 Targets)

**Focus**: unit
**New files**: 3
- `src/main/services/__tests__/conversation-state-machine.test.ts` — 12 tests
- `src/main/services/__tests__/intent-detector.test.ts` — 10 tests
- `src/main/services/__tests__/intent-router.test.ts` — 8 tests

**New tests**: 30
**Coverage impact**: 3 critical P0 services now have full branch coverage
**All tests passing**: verified via `npx tsx src/main/services/__tests__/run-tests.ts` (222 passed, 0 failed)
**Next**: generalist-prompt-assembler, tool-approval, circuit-breaker

---

## [Run 3] 2026-04-21 — Unit Tests (P0 Continued)

**Focus**: unit
**New files**: 3
- `src/main/services/__tests__/generalist-circuit-breaker.test.ts` — 10 tests
- `src/main/services/__tests__/tool-approval.test.ts` — 10 tests
- `src/main/services/__tests__/generalist-prompt-assembler.test.ts` — 10 tests

**New tests**: 30
**Coverage impact**: All 6 P0 services now have unit test coverage
**All tests passing**: verified via `npx tsx src/main/services/__tests__/run-tests.ts` (252 passed, 0 failed)
**Factory added**: `createPromptAssembler()` in agent-factory.ts
**Next**: P1 targets — cost-tracker, token-tracker, decomposition, circuit-breaker expansion

---

## [Run 4] 2026-04-21 — Unit Tests (P1 Targets)

**Focus**: unit
**New files**: 4
- `src/main/services/__tests__/cost-tracker.test.ts` — 10 tests
- `src/main/services/__tests__/generalist-token-tracker.test.ts` — 8 tests
- `src/main/services/__tests__/complexity-scorer.test.ts` — 10 tests
- `src/main/services/__tests__/elicitation.test.ts` — 2 tests

**New tests**: 30
**Coverage impact**: 4 P1 services now have unit test coverage
**All tests passing**: verified via `npx tsx src/main/services/__tests__/run-tests.ts` (390 passed, 0 failed)
**Factories added**: `createTokenTracker()`, `createElicitationService()` in agent-factory.ts
**Next**: P1 expansion — model-config expansion, specialist-pool targeted methods

---

## [Run 5] 2026-04-21 — Unit Tests (P1 Expansion + P2 Specialist Internals)

**Focus**: unit
**New files**: 4
- `src/main/services/__tests__/abandonment-detector.test.ts` — 12 tests
- `src/main/services/__tests__/scheduling-strategy.test.ts` — 10 tests
- `src/main/services/__tests__/semaphore.test.ts` — 6 tests
- `src/main/services/__tests__/investigation-detect.test.ts` — 2 tests

**New tests**: 30
**Coverage impact**: abandonment-detector (3 functions), scheduling strategies (4 strategies + composite),
  Semaphore (async concurrency), investigation-detect now all covered
**All tests passing**: verified via `npx tsx src/main/services/__tests__/run-tests.ts` (420 ✓, 0 failed)
**Next**: P2 expansion — message-bus, rate-limiter, quality-gate-runner, model-config expansion

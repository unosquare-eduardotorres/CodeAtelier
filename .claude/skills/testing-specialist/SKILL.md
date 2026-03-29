---
name: testing
description: >
  Write and organize unit, integration, and end-to-end (E2E) tests for any codebase
  or framework. Use this skill whenever the user asks to add tests, improve test
  coverage, set up a testing framework, write specs, create test suites, debug failing
  tests, or mentions keywords like "unit test", "integration test", "E2E", "end-to-end",
  "test coverage", "TDD", "BDD", "mocking", "fixtures", "test runner", "pytest", "jest",
  "vitest", "playwright", "cypress", "selenium", "xUnit", "NUnit", "JUnit", "Karma",
  "Jasmine", "Spectron", "Electron testing", "Claude SDK test", "Claude CLI test",
  "promptfoo", or "testing strategy". Also trigger when the user asks to refactor code
  and wants regression tests first, when reviewing code and suggesting test improvements,
  or when building CI/CD pipelines that include test stages. Even if the user just says
  "add tests" without specifying a level or framework, use this skill to determine the
  right approach.
---

# Testing Skill

Write clear, maintainable, high-confidence tests at every level of the testing pyramid,
across any language and framework.

## Step 0 — Detect the Stack and Load the Right Reference

Before writing any test, identify:

1. **Language & runtime** (Python, TypeScript/JavaScript, C#/.NET, Java, Go, Rust, etc.)
2. **Framework in use** (React, Angular, Node/Express, FastAPI, ASP.NET, Spring Boot, Electron, etc.)
3. **Existing test setup** — look for config files: `jest.config.*`, `vitest.config.*`,
   `pytest.ini`, `pyproject.toml`, `cypress.config.*`, `playwright.config.*`, `karma.conf.*`,
   `angular.json`, `.csproj` test references, `pom.xml` surefire plugin, `electron-builder.*`
4. **What the user wants tested** — a function, a module, an API, a UI flow, an AI integration

Then read the appropriate reference file(s):

| Stack / Framework              | Reference file                          |
|--------------------------------|-----------------------------------------|
| Python (pytest, FastAPI, etc.) | `references/python.md`                  |
| JavaScript / TypeScript        | `references/javascript-typescript.md`   |
| React                          | `references/react.md`                   |
| Angular                        | `references/angular.md`                 |
| Node.js / Express / NestJS     | `references/node.md`                    |
| .NET / C# (xUnit, NUnit)      | `references/dotnet.md`                  |
| Java (JUnit, Spring Boot)      | `references/java.md`                    |
| Electron                       | `references/electron.md`                |
| Claude CLI & SDKs              | `references/claude-ai.md`              |
| E2E (Playwright, Cypress)      | `references/e2e.md`                     |
| General patterns & philosophy  | `references/patterns.md`                |

Multiple references can be combined. For example, testing a React + Node full-stack app
would use `references/react.md` + `references/node.md` + `references/e2e.md`.

## Step 1 — Choose the Right Test Level

### Unit Tests
Test a single function, method, or class **in isolation**. All external dependencies
are mocked or stubbed.

Write when: meaningful logic exists (conditionals, transformations, calculations,
parsing). Skip when: code is pure glue with no logic, or trivially simple.

### Integration Tests
Test how multiple components work **together** — a module calling a real database,
an API endpoint hit with an in-memory server, two services communicating.

Write when: database queries, API contracts, service interactions, or anything where
mocks would hide real bugs. Skip when: the integration is already well-covered by
E2E tests and the contract is stable.

### E2E Tests
Test the full user-facing flow from the **outside in** — browser clicks, CLI commands,
API sequences simulating a real user session.

Write when: critical user journeys (login, checkout, onboarding), system-level
verification after deployment. Keep lean: 10-20 focused E2E tests beat 200 brittle
ones. Don't duplicate what lower levels already cover.

## Step 2 — Write the Tests

These principles apply to every test at every level, in every framework.

### Naming
State the scenario and expected outcome. A test name is a specification:
```
test_parse_csv_with_empty_rows_skips_blanks
it("returns 401 when token is expired")
CalculateDiscount_WithNegativePrice_ThrowsArgumentException
```

### Structure — Arrange / Act / Assert
1. **Arrange** — set up inputs, mocks, fixtures, state
2. **Act** — call the function / hit the endpoint / perform the action
3. **Assert** — verify the outcome

One act per test. Related assertions are fine; unrelated ones get their own test.

### Isolation
- Unit: mock all externals (DB, HTTP, filesystem, clock)
- Integration: real dependencies in controlled environments (test DB, in-memory server)
- E2E: full stack running locally or in CI

### Determinism
No flakiness. Freeze time, seed RNGs, avoid order-dependent tests, mock external APIs
or use recorded responses (VCR/Polly pattern). Every test passes 100% of the time when
code is correct.

### What to Cover
- Happy path, edge cases (empty, null, boundary), error paths, auth failures
- Don't cover: generated code, trivial getters, framework boilerplate
- Aim for meaningful coverage, not a coverage number

## Step 3 — Organize the Suite

Follow the project's existing convention. If none exists, use the framework defaults
from the reference file. General rules:

- Mirror source structure in test directories
- Extract shared setup into fixtures/helpers, named after what they provide
- Tag tests by level (`@pytest.mark.unit`, describe blocks, xUnit traits) so they
  can be run selectively
- Run in CI in order of speed: unit → integration → E2E. Fail fast.

## Step 4 — Validate

After writing tests:
1. Run them. Fix failures before presenting.
2. Check coverage and note important gaps.
3. Review quality: are assertions meaningful? Would they catch a real bug?

Present the user a summary: tests added per level, key scenarios covered,
intentional gaps and reasoning.

## Common Pitfalls

- **Testing implementation details** — assert behavior, not internal state
- **Over-mocking** — if you mock everything, you test your mocks
- **Flaky tests** — fix or delete; flakiness erodes trust
- **Test duplication** — unit test logic, integration test wiring, E2E test journeys
- **Ignoring readability** — tests are documentation for the next developer

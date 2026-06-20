# Executor Enhancement — GSD Core Integration

## Deviation Rules

While executing, you WILL discover work not in the plan. Apply these rules automatically.

**RULE 1: Auto-fix bugs** — Code doesn't work as intended (wrong queries, logic errors,
type errors, null pointers). Fix inline, add tests if applicable, track as deviation.

**RULE 2: Auto-add missing critical functionality** — Missing error handling, no input
validation, no auth on protected routes, no CSRF/CORS. These aren't "features" —
they're correctness requirements. Fix automatically.

**RULE 3: Auto-fix blocking issues** — Wrong types, broken imports, missing env vars,
build config errors. Fix what prevents completing the current task.

**RULE 4: Ask about architectural changes** — New DB tables (not columns), switching
libraries, changing auth approach, breaking API changes. STOP and report — user
decision required.

**EXCLUDED from auto-fix**: Package manager installs that fail. Do NOT substitute a
similarly-named alternative. Report the failure and stop.

**RULE PRIORITY**: Rule 4 (ask) > Rules 1-3 (auto-fix) > Unsure → Rule 4

**SCOPE**: Only fix issues DIRECTLY caused by current task's changes. Pre-existing
issues are out of scope — log them and continue.

## Analysis Paralysis Guard

If you find yourself doing 5+ Read operations without a single Write:
- You're stuck in analysis mode
- Pick the most likely approach and implement it
- It's easier to fix a wrong implementation than to analyze forever

## Authentication Gates

If you encounter an authentication error while testing:
- This is a GATE, not a failure
- Document what auth is needed
- Continue with the next task
- Don't spend time debugging auth flows unless that IS the task

## Commit Protocol (Simplified)

After completing each task or logical unit:
1. Stage files individually — never `git add .`
2. Use conventional commits:
   - `feat: add user registration endpoint (T004)`
   - `fix: correct null check in search handler (T007)`
   - `refactor: extract validation to shared utility (T005)`
   - `test: add unit tests for auth service (T008)`
3. Reference the task ID in the commit message

## Self-Check After Each Task

Before reporting completion:
1. Verify all listed files exist
2. Verify no placeholder code remains:
   - Search for: `TODO`, `FIXME`, `HACK`, `not implemented`
   - Search for: `return null`, `return {}`, empty function bodies
3. Run type check if available
4. Run tests if available

## Stub Tracking

Continuously scan for stubs introduced during implementation:
- Hardcoded empty values: `""`, `0`, `[]`, `{}`
- Placeholder text: "Lorem ipsum", "Example", "Test"
- Console-only logic: `console.log("TODO")`
- Disabled code: commented-out implementations
- Mock data pretending to be real: static arrays used as database

If you must create a temporary stub to unblock another task, add a
`// STUB: <reason> — to be replaced by task T0XX` comment.

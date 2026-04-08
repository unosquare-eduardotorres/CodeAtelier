# Manual Smoke Test Checklist: Orchestrator -> Generalist Migration

Use this checklist for manual E2E validation of the Generalist + SubAgent migration in Agent Studio.

## Prerequisites

- [ ] Install dependencies (`npm install`)
- [ ] Run typecheck (`npm run typecheck` or project-standard command)
- [ ] Start the app (`npm run dev`)
- [ ] Confirm app opens and chat UI is interactive
- [ ] Use a writable test workspace with a Git repo

## Test 1: Workspace Initialization

- Goal: verify baseline workspace and conversation startup.
- Steps:
  - [ ] Open or create a workspace
  - [ ] Create a new conversation
  - [ ] Send a simple prompt and wait for completion
  - [ ] Confirm no orchestrator startup requirement appears
- Expected:
  - [ ] Conversation persists and response streams successfully
  - [ ] Generalist handles the exchange without migration errors

## Test 2: Plan Mode Handoff + Decomposition

- Goal: verify plan-mode decomposition path through Generalist.
- Steps:
  - [ ] Switch to Plan mode
  - [ ] Ask for specialist investigation requiring decomposition
  - [ ] Confirm handoff/decomposition is triggered
  - [ ] Confirm non-empty task plan is produced
- Expected:
  - [ ] Tasks include specialist, description, and dependency fields
  - [ ] Plan-mode tasks are investigation-focused (not direct implementation)

## Test 3: Build Mode SubAgent Execution

- Goal: verify task execution uses SDK SubAgents.
- Steps:
  - [ ] Switch to Build mode
  - [ ] Execute a prepared task plan
  - [ ] Observe progress/events while tasks run
  - [ ] Verify dependency order is respected
- Expected:
  - [ ] Generalist delegates work to SubAgents
  - [ ] Execution completes with a final summary and no orchestrator usage

## Test 4: Error Handling

- Goal: verify graceful failure behavior after migration.
- Steps:
  - [ ] Trigger a decomposition failure path (invalid decomposition input/response)
  - [ ] Trigger a SubAgent execution failure path
  - [ ] Observe UI and conversation behavior during failures
- Expected:
  - [ ] Clear user-facing error messages are shown
  - [ ] No silent legacy fallback is used
  - [ ] Conversation remains usable for follow-up actions

## Test 5: Session Continuity

- Goal: verify session resume and context continuity.
- Steps:
  - [ ] Run one decomposition + execution cycle
  - [ ] Reopen the same conversation (or restart app then reopen)
  - [ ] Send a follow-up message referencing earlier context
- Expected:
  - [ ] Prior context is retained and reflected in response
  - [ ] No unexpected session reset or duplication occurs

## Test 6: Conversation Lifecycle

- Goal: verify stop/close/complete/delete lifecycle paths.
- Steps:
  - [ ] Start a long-running response and click Stop
  - [ ] Trigger/mark conversation complete
  - [ ] Close and reopen conversation from list
  - [ ] Delete conversation
- Expected:
  - [ ] Lifecycle actions complete without stuck agent states
  - [ ] Deletion removes conversation data and UI entry cleanly

## Sign-off

- [ ] All six smoke tests passed
- [ ] Failures (if any) captured with repro steps and logs
- [ ] Migration is ready for broader QA/UAT validation

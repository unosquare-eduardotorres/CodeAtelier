# Tasks: {{FEATURE_NAME}}

**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Organization**: Tasks are grouped by wave for execution ordering
and by user story for traceability.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Wave 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per implementation plan
- [ ] T002 [P] Configure dependencies and tooling

---

## Wave 2: Foundation (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before user story work

- [ ] T003 Setup data models and schema
- [ ] T004 [P] Implement core framework structure
- [ ] T005 [P] Configure error handling and logging

**Checkpoint**: Foundation ready — user story implementation can begin

---

## Wave 3+: User Stories (Priority Order)

### User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [What this story delivers]

- [ ] T006 [US1] Implement core feature
- [ ] T007 [US1] Add validation and error handling
- [ ] T008 [US1] Add tests

**Checkpoint**: US1 independently functional

---

[Additional waves for US2, US3, etc.]

---

## Final Wave: Polish & Cross-Cutting

- [ ] TXXX [P] Documentation updates
- [ ] TXXX Code cleanup
- [ ] TXXX Performance optimization

---

## Dependencies & Execution Order

### Wave Dependencies

- **Wave 1 (Setup)**: No dependencies — starts immediately
- **Wave 2 (Foundation)**: Depends on Wave 1 — BLOCKS all user stories
- **Wave 3+ (User Stories)**: Depend on Wave 2 completion
- **Final Wave**: Depends on all desired user stories

### Parallel Opportunities

- Tasks marked [P] within the same wave can run concurrently
- Different user stories can run in parallel (if in same wave with no file overlap)

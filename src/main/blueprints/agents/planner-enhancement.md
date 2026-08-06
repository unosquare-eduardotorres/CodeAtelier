# Planner Enhancement — GSD Core Integration

## Goal-Backward Methodology

Before creating any plan items, work backward from the goal:

1. **State the Goal** — outcome-shaped, from the user's perspective
   - Good: "Working photo album organizer" (outcome)
   - Bad: "Build photo components" (task)

2. **Derive Observable Truths** — 3-7 things that must be TRUE
   - "User can see their albums listed"
   - "User can drag photos between albums"
   - Each truth maps to a testable behavior

3. **Derive Required Artifacts** — for each truth, what files must EXIST
   - Map to concrete file paths in the project
   - Include both source and test files

4. **Derive Required Wiring** — for each artifact, what must be CONNECTED
   - Component imports, route registrations, DB queries
   - This is where stubs hide — wiring gaps = hollow features

5. **Identify Key Links** — critical connections where breakage cascades
   - Component → API, API → Database, Form → Handler, State → Render
   - These are the verification targets

## Scope Reduction Prohibition

**PROHIBITED language in plan items:**

- "v1", "v2", "simplified version", "static for now", "hardcoded for now"
- "future enhancement", "placeholder", "basic version", "minimal implementation"
- Any language that reduces a spec requirement to less than what was specified

**The rule:** If the spec says "display cost calculated from billing table",
the plan MUST deliver cost calculated from billing table. NOT "static label"
as a simplified first pass.

**When scope seems too large:** SPLIT the work into smaller items that each
deliver full functionality for a subset. Never deliver partial functionality.

## Interface-First Ordering

1. Define contracts (types, interfaces, schemas) first
2. Implement core logic against contracts
3. Wire components together
4. This ordering prevents "implement → discover interface mismatch → rewrite"

## Dependency Graph Building

- Prefer **vertical slices** over horizontal layers
- A vertical slice: DB → Service → API → UI for one user story
- A horizontal layer: ALL DB models, then ALL services, then ALL APIs
- Vertical slices deliver testable value earlier

## File Ownership for Parallelism

- Tasks that touch different files can run in parallel
- Tasks that share files MUST be sequential
- When splitting, ensure file sets don't overlap within a wave

## Task Sizing by Context Budget

Each task should consume 10-30% of the agent's context window:

- 0-3 files: ~10-15% context (small task)
- 4-6 files: ~20-30% context (medium task)
- 7+ files: too large — split it

**Split signals:**

- More than 3 sub-tasks within one plan item
- Touches multiple subsystems (frontend + backend + DB)
- More than 5 file modifications
- Any task estimated at >30% context

## Checkpoint Types

Use these checkpoint categories between plan items:

- **human-verify** (90%): Automated check is sufficient
- **decision** (9%): User must choose between alternatives
- **human-action** (1%): User must perform manual action (deploy, configure, etc.)

# AgentStudio Upgrade Plan: Multi-Agent Intelligence Layer

> **Purpose**: Phased implementation plan to integrate the best orchestration patterns from DevTeam, wshobson/agents, and multi-agent-squad into AgentStudio.
>
> **How to use**: Feed each phase to Claude as a standalone task. Each phase is self-contained with exact file paths, code references, interfaces, and acceptance criteria.
>
> **Reference repos** (all cloned in `~/Downloads/external repos/`):
> - **DevTeam**: `~/Downloads/external repos/devteam/`
> - **wshobson/agents**: `~/Downloads/external repos/agents/`
> - **Multi-Agent Squad**: `~/Downloads/external repos/multi-agent-squad/`

---

## Table of Contents

- [Phase 1: Complexity Scoring & Model Routing](#phase-1-complexity-scoring--model-routing)
- [Phase 2: Task Loop with Quality Gates](#phase-2-task-loop-with-quality-gates)
- [Phase 3: Anti-Abandonment Detection](#phase-3-anti-abandonment-detection)
- [Phase 4: File-Based Agent Communication Chain](#phase-4-file-based-agent-communication-chain)
- [Phase 5: Cost Tracking Dashboard](#phase-5-cost-tracking-dashboard)
- [Phase 6: Human Checkpoint UI](#phase-6-human-checkpoint-ui)
- [Phase 7: Progressive Skill Loading](#phase-7-progressive-skill-loading)
- [Phase 8: Scope Enforcement Layer](#phase-8-scope-enforcement-layer)
- [Phase 9: Declarative Hooks System](#phase-9-declarative-hooks-system)
- [Phase 10: Deep Agent Personas & Bug Council](#phase-10-deep-agent-personas--bug-council)

---

## Phase 1: Complexity Scoring & Model Routing

### Goal
Stop using a single model for all specialists. Score every task by complexity (0-14) and route to the cheapest capable model. This alone saves 40-60% on API costs.

### Reference Code
- **DevTeam scoring algorithm**: `~/Downloads/external repos/devteam/agents/orchestration/task-loop.md` (lines describing complexity scoring)
- **DevTeam model tiers**: `~/Downloads/external repos/devteam/.devteam/task-loop-config.yaml`
- **wshobson tier assignments**: `~/Downloads/external repos/agents/docs/agents.md` (Opus/Sonnet/Haiku/Inherit mapping for 112 agents)

### Current State in AgentStudio
- `src/shared/constants.ts` defines `ACTIVATION_MODEL_ID = 'claude-sonnet-4-20250514'` and `BRAIN_FEED_MODEL_ID = 'claude-haiku-4-20250414'` but these are only used for workspace activation and brain summarization.
- `src/main/services/orchestrator.service.ts` spawns `claude -p` without any `--model` flag override per task.
- `src/main/services/specialist-pool.service.ts` spawns specialists without model selection — all inherit the Claude CLI default.
- `src/shared/types.ts` defines `DecomposedTask` with `title`, `description`, `agentId`, `dependencies`, `priority` — but no `complexity` or `model` fields.

### What to Build

#### 1.1 — Complexity Scoring Service

Create a new service: `src/main/services/complexity-scorer.service.ts`

```typescript
// Reference: DevTeam task-loop.md scoring algorithm
//
// Scoring dimensions (0-14 total):
//   Files affected:     0-3 pts  (1 file=0, 2-3=1, 4-6=2, 7+=3)
//   Estimated lines:    0-3 pts  (<50=0, 50-150=1, 150-300=2, 300+=3)
//   New dependencies:   0-2 pts  (0=0, 1-2=1, 3+=2)
//   Task type:          0-3 pts  (docs=0, test=1, impl=2, arch=3)
//   Risk flags:         0-3 pts  (1pt each: security, external_integration, breaking_change)
//
// Tier mapping:
//   0-4:   Simple   → haiku
//   5-8:   Moderate → sonnet
//   9-14:  Complex  → opus

export interface ComplexityScore {
  filesAffected: number       // 0-3
  estimatedLines: number      // 0-3
  newDependencies: number     // 0-2
  taskType: number            // 0-3
  riskFlags: number           // 0-3
  total: number               // 0-14
  tier: 'simple' | 'moderate' | 'complex'
  model: 'haiku' | 'sonnet' | 'opus'
}

export function scoreComplexity(task: DecomposedTask): ComplexityScore
```

**Scoring implementation**: Use the orchestrator's existing `decompose()` method output. The `DecomposedTask` already has `title` and `description`. Parse these for:
- File count estimation (look for file paths, "modify X files" language)
- Task type keywords: "test" → 1pt, "implement"/"create" → 2pt, "architect"/"design"/"refactor" → 3pt, "document"/"update readme" → 0pt
- Risk keywords: "auth"/"security"/"encryption" → +1pt, "API"/"webhook"/"external" → +1pt, "migration"/"breaking"/"schema change" → +1pt
- Dependency keywords: "install"/"add package"/"new dependency" → count

For higher accuracy, optionally make a lightweight LLM call (haiku) with a structured prompt that returns the score as JSON. Reference DevTeam's approach where the task-loop agent evaluates complexity before spawning implementation agents.

#### 1.2 — Extend DecomposedTask Type

In `src/shared/types.ts`, extend the `DecomposedTask` interface:

```typescript
export interface DecomposedTask {
  title: string
  description: string
  agentId: string
  dependencies: string[]
  priority: number
  // NEW fields:
  complexity?: ComplexityScore
  model?: 'haiku' | 'sonnet' | 'opus'
  maxRetries?: number
}
```

#### 1.3 — Model Routing in Specialist Pool

In `src/main/services/specialist-pool.service.ts`, modify the `spawnSpecialist()` method (around the `spawn('claude', args)` call) to include the model flag:

```typescript
// CURRENT: args = ['--yes', '-p', task.description, ...]
// NEW: add model routing
const model = task.model || this.getModelForComplexity(task.complexity?.total || 5)
const args = ['--yes', '-p', task.description, '--model', model, ...]
```

Add a model selection method:

```typescript
private getModelForComplexity(score: number): string {
  if (score <= 4) return 'claude-haiku-4-20250414'
  if (score <= 8) return 'claude-sonnet-4-20250514'
  return 'claude-opus-4-20250514'
}
```

#### 1.4 — Wire Scoring into Orchestrator

In `src/main/services/orchestrator.service.ts`, after `decompose()` returns tasks, score each one:

```typescript
const tasks = await this.decompose(handoffSummary)
for (const task of tasks) {
  task.complexity = scoreComplexity(task)
  task.model = task.complexity.model
}
```

#### 1.5 — Workspace-Level Model Override

In `src/shared/types.ts`, extend workspace settings to allow users to control cost:

```typescript
// Reference: wshobson/agents "inherit" tier concept
export type CostPreference = 'economy' | 'balanced' | 'power'

// economy: always start with haiku, escalate slower
// balanced: use complexity scoring (default)
// power: always use opus
```

Store this in the workspace `settings_json` column. Expose in the Settings UI.

### Database Changes

Add to `src/main/db/schema.sql`:

```sql
-- Track complexity scores per task execution
ALTER TABLE agent_sessions ADD COLUMN complexity_score INTEGER;
ALTER TABLE agent_sessions ADD COLUMN model_used TEXT;
ALTER TABLE agent_sessions ADD COLUMN model_tier TEXT; -- 'simple', 'moderate', 'complex'
```

### Acceptance Criteria
- [ ] Every specialist task gets a complexity score before execution
- [ ] Specialists spawn with the correct `--model` flag based on score
- [ ] Users can set a workspace-level cost preference (economy/balanced/power)
- [ ] `agent_sessions` table records which model was used and the complexity score
- [ ] Simple tasks (docs, config changes) consistently route to haiku
- [ ] Complex tasks (architecture, security) consistently route to opus

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/complexity-scorer.service.ts` |
| MODIFY | `src/shared/types.ts` — extend `DecomposedTask`, add `ComplexityScore`, `CostPreference` |
| MODIFY | `src/shared/constants.ts` — add model ID constants per tier |
| MODIFY | `src/main/services/orchestrator.service.ts` — wire scoring after decompose |
| MODIFY | `src/main/services/specialist-pool.service.ts` — pass `--model` flag |
| MODIFY | `src/main/db/schema.sql` — add columns to `agent_sessions` |
| MODIFY | `src/main/db/repositories/agent-session.repository.ts` — persist new fields |

---

## Phase 2: Task Loop with Quality Gates

### Goal
Wrap every specialist execution in an iterative loop: Execute → Validate → Pass? Done. Fail? Fix → Escalate model → Retry. No specialist completes until quality gates pass.

### Reference Code
- **DevTeam Task Loop**: `~/Downloads/external repos/devteam/agents/orchestration/task-loop.md` — The full loop architecture with model escalation
- **DevTeam Quality Gate Enforcer**: `~/Downloads/external repos/devteam/agents/orchestration/quality-gate-enforcer.md` — Gate definitions and commands per language
- **DevTeam task-loop-config.yaml**: `~/Downloads/external repos/devteam/.devteam/task-loop-config.yaml` — Iteration limits, escalation thresholds
- **Multi-Agent Squad hooks**: `~/Downloads/external repos/multi-agent-squad/.claude/hooks/enterprise-workflow.toml` — PostToolUse auto-test/lint patterns
- **wshobson/agents TDD workflow**: `~/Downloads/external repos/agents/plugins/conductor/commands/implement.md` — Red-green-refactor enforcement

### Current State in AgentStudio
- `src/main/services/specialist-pool.service.ts` has retry logic (`RETRY_CONFIG`: maxRetries=2, exponential backoff) but retries use the **same model and same approach**. There's no quality validation — a specialist "succeeds" simply by exiting with code 0.
- No post-execution test/lint/typecheck validation exists.
- No model escalation on retry — same model every time.

### What to Build

#### 2.1 — Quality Gate Service

Create: `src/main/services/quality-gate.service.ts`

```typescript
// Reference: DevTeam quality-gate-enforcer.md
//
// Gates to run (detected from project):
//   - tests:     npm test / pytest / go test / dotnet test
//   - typecheck: tsc --noEmit / mypy / go vet
//   - lint:      eslint / ruff / golangci-lint
//
// Each gate returns: { gate: string, passed: boolean, output: string, duration: number }
//
// Overall result: ALL gates must pass for task to complete

export interface GateResult {
  gate: 'tests' | 'typecheck' | 'lint' | 'security'
  passed: boolean
  output: string
  command: string
  durationMs: number
  exitCode: number
}

export interface QualityGateReport {
  allPassed: boolean
  gates: GateResult[]
  failedGates: string[]
  timestamp: string
}

export class QualityGateService {
  // Detect project type from workspace path
  // Returns which gates are applicable
  async detectGates(workspacePath: string): Promise<string[]>

  // Run all applicable gates
  // Reference commands from DevTeam quality-gate-enforcer.md:
  //   Python:      uv run pytest -v --tb=short
  //   TypeScript:  npm test -- --passWithNoTests
  //   Go:          go test -v ./...
  //   C#:          dotnet test
  //   Typecheck:   npx tsc --noEmit (TS), uv run mypy . (Python)
  //   Lint:        npx eslint . (TS), uv run ruff check . (Python)
  async runGates(workspacePath: string): Promise<QualityGateReport>
}
```

**Gate detection logic**: Check for `package.json` (Node/TS), `pyproject.toml`/`requirements.txt` (Python), `go.mod` (Go), `*.csproj` (C#). Look at `scripts` in package.json for test/lint commands. Prefer project-defined commands over defaults.

#### 2.2 — Task Loop Wrapper

Create: `src/main/services/task-loop.service.ts`

```typescript
// Reference: DevTeam task-loop.md
//
// Loop architecture:
//   1. Execute specialist
//   2. Run quality gates
//   3. If ALL pass → COMPLETE
//   4. If any fail → create fix description from gate output
//   5. Check escalation: 2 consecutive failures at same model → escalate
//   6. Re-execute with fix context + possibly upgraded model
//   7. Max 10 iterations → surface to user
//
// Escalation chain (from DevTeam task-loop-config.yaml):
//   haiku fails 2x  → sonnet
//   sonnet fails 2x → opus
//   opus fails 3x   → surface to user (Bug Council in Phase 10)
//
// Stuck loop detection (from DevTeam task-loop.md):
//   Same test failing 3x in a row → ESCALATE immediately
//   Same error message 3x → ESCALATE immediately

export interface TaskLoopConfig {
  maxIterations: number           // default: 10
  escalationThreshold: number     // consecutive failures before escalate (default: 2)
  opusMaxFailures: number         // failures at opus before giving up (default: 3)
  runQualityGates: boolean        // can disable for non-code tasks
  gateTimeout: number             // ms, default: 120000 (2 min)
}

export interface TaskLoopState {
  iteration: number
  currentModel: string
  consecutiveFailures: number
  failureHistory: Array<{
    iteration: number
    model: string
    failedGates: string[]
    errorSummary: string
  }>
  status: 'running' | 'passed' | 'failed' | 'escalated' | 'max_iterations'
}

export class TaskLoopService extends EventEmitter {
  // Events: 'iteration', 'gateResult', 'escalation', 'complete', 'maxIterations'

  async executeWithLoop(
    task: DecomposedTask,
    workspacePath: string,
    config?: Partial<TaskLoopConfig>
  ): Promise<TaskLoopState>
}
```

**Loop implementation**:

```
for each iteration (1..maxIterations):
  1. Spawn specialist with current model (using specialist-pool logic)
  2. Wait for specialist to complete
  3. If task is non-code (docs, config): mark COMPLETE, break
  4. Run quality gates via QualityGateService
  5. If all gates pass: mark COMPLETE, break
  6. If gates fail:
     a. Increment consecutiveFailures
     b. Check stuck detection:
        - Same test name failing 3x? → force escalate
        - Same error output 3x? → force escalate
     c. If consecutiveFailures >= escalationThreshold:
        - haiku → sonnet (reset counter)
        - sonnet → opus (reset counter)
        - opus and failures >= opusMaxFailures → mark FAILED, emit 'maxIterations'
     d. Build fix context from gate output:
        "Previous attempt failed. Gate results: [output]. Fix these issues: [failed gates]"
     e. Append fix context to task description for next iteration
  7. Emit 'iteration' event with current state
```

#### 2.3 — Integrate Task Loop into Specialist Pool

In `src/main/services/specialist-pool.service.ts`, replace the direct specialist spawn with the task loop:

```typescript
// CURRENT (simplified):
// spawnSpecialist(task) → wait for exit → done

// NEW:
// taskLoopService.executeWithLoop(task, workspacePath) → iterates until quality gates pass
```

The specialist pool's existing retry logic (`RETRY_CONFIG`) handles process-level failures (crashes, timeouts). The task loop handles **logical failures** (tests not passing, lint errors). These are complementary:
- Process crash → specialist-pool retries (same model, same prompt)
- Quality gate failure → task-loop retries (upgraded model, fix context added)

#### 2.4 — IPC Events for Loop Progress

Add new IPC channels in `src/shared/constants.ts`:

```typescript
TASK_LOOP_ITERATION: 'task:loop:iteration',
TASK_LOOP_GATE_RESULT: 'task:loop:gate-result',
TASK_LOOP_ESCALATION: 'task:loop:escalation',
TASK_LOOP_COMPLETE: 'task:loop:complete',
```

Forward these from the main process to the renderer so the UI can show loop progress.

#### 2.5 — UI: Loop Progress Indicator

In the specialist task progress UI, show:
- Current iteration (e.g., "Iteration 2/10")
- Current model tier (e.g., "sonnet" with color indicator)
- Gate results (pass/fail badges for tests, lint, types)
- Escalation events (e.g., "Escalated from haiku to sonnet after 2 failures")

### Database Changes

```sql
CREATE TABLE task_loop_iterations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT REFERENCES agent_sessions(id),
  iteration INTEGER NOT NULL,
  model_used TEXT NOT NULL,
  gates_passed BOOLEAN NOT NULL DEFAULT 0,
  failed_gates TEXT,              -- JSON array of gate names
  gate_output TEXT,               -- full gate output for debugging
  escalated BOOLEAN DEFAULT 0,
  escalated_from TEXT,            -- previous model
  escalated_to TEXT,              -- new model
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Acceptance Criteria
- [ ] Every specialist task runs inside a task loop
- [ ] Quality gates (test/lint/typecheck) run after each specialist completes
- [ ] Failed gates trigger retry with fix context appended to prompt
- [ ] Model escalates after 2 consecutive failures (haiku→sonnet→opus)
- [ ] Stuck loop detection triggers immediate escalation
- [ ] Max 10 iterations before surfacing to user
- [ ] UI shows iteration count, model tier, and gate results in real-time
- [ ] All loop iterations are persisted in the database for analytics

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/quality-gate.service.ts` |
| CREATE | `src/main/services/task-loop.service.ts` |
| MODIFY | `src/main/services/specialist-pool.service.ts` — integrate task loop |
| MODIFY | `src/shared/constants.ts` — add loop IPC channels |
| MODIFY | `src/shared/types.ts` — add TaskLoopState, GateResult, QualityGateReport |
| MODIFY | `src/main/db/schema.sql` — add `task_loop_iterations` table |
| CREATE | `src/main/db/repositories/task-loop.repository.ts` |
| MODIFY | `src/renderer/src/components/agents/TaskProgress.tsx` — show loop state |

---

## Phase 3: Anti-Abandonment Detection

### Goal
Detect when a specialist is giving up ("I cannot", "this is beyond my capabilities", "you should manually") and inject a re-engagement prompt instead of accepting the failure.

### Reference Code
- **DevTeam persistence hook**: `~/Downloads/external repos/devteam/hooks/persistence-hook.sh` — Complete regex patterns for abandonment detection with categorized patterns (direct abandonment, premature completion, deflection, permission seeking)
- **DevTeam persistence config**: `~/Downloads/external repos/devteam/.devteam/persistence-config.yaml` — Re-engagement prompt templates

### Current State in AgentStudio
- `src/main/services/agent-base.service.ts` processes NDJSON chunks and emits them. No content analysis.
- `src/main/services/generalist.service.ts` already accumulates text for handoff detection (regex on `accumulatedText`). The same pattern can detect abandonment.
- `src/main/services/specialist-pool.service.ts` treats any exit code 0 as success. An agent can say "I give up" and exit 0, and it's accepted.

### What to Build

#### 3.1 — Abandonment Detector

Create: `src/main/services/abandonment-detector.service.ts`

```typescript
// Reference: DevTeam persistence-hook.sh
//
// Pattern categories (from the hook):
//
// DIRECT ABANDONMENT:
//   "I cannot complete this"
//   "I'm unable to"
//   "I give up"
//   "I'm stuck"
//   "beyond my capabilities"
//   "unable to resolve"
//   "cannot figure out"
//
// PREMATURE COMPLETION:
//   "I've done what I can"
//   "I've tried everything"
//   "I'm out of ideas"
//   "there's nothing more I can do"
//   "I've exhausted"
//
// DEFLECTION TO USER:
//   "You should try"
//   "This requires human"
//   "You'll need to manually"
//   "I recommend you"
//   "a human developer should"
//
// PERMISSION SEEKING (less critical, but still suspicious):
//   "Should I proceed"
//   "Do you want me to"
//   "Would you like me to"
//
// LEGITIMATE STOP (whitelist — do NOT block):
//   "All tests passing"
//   "Task completed successfully"
//   "Implementation complete"
//   "All quality gates passed"

export interface AbandonmentDetection {
  detected: boolean
  category: 'direct' | 'premature' | 'deflection' | 'permission' | null
  matchedPhrase: string | null
  confidence: number  // 0-1
}

export class AbandonmentDetector {
  // Analyze accumulated text for abandonment signals
  detect(text: string): AbandonmentDetection

  // Generate re-engagement prompt based on detection category
  // Reference: DevTeam persistence-config.yaml re-engagement templates
  getReEngagementPrompt(detection: AbandonmentDetection, taskDescription: string): string
}
```

**Re-engagement prompts by category**:

```typescript
const RE_ENGAGEMENT_PROMPTS = {
  direct: `You indicated you cannot complete this task. This is not acceptable.
You MUST continue working. Try a different approach:
1. Break the problem into smaller steps
2. Search the codebase for similar patterns
3. Simplify your implementation
4. Focus on the core requirement, not edge cases
Resume work now.`,

  premature: `You claimed to have tried everything, but the task is not complete.
The quality gates have not passed. You have NOT exhausted all options:
1. Re-read the error messages carefully
2. Check the test output for specific failure reasons
3. Look at existing passing tests for patterns
4. Try the simplest possible fix first
Continue working.`,

  deflection: `You attempted to defer this task to a human. You are the assigned specialist.
Do not suggest manual intervention. Instead:
1. Identify the specific blocker
2. Research the error or missing dependency
3. Implement a workaround if the ideal solution is blocked
4. Document what you tried in comments
Keep working on this task.`
}
```

#### 3.2 — Wire into Specialist Pool

In `src/main/services/specialist-pool.service.ts`, accumulate specialist stdout text and check for abandonment before marking a task complete:

```typescript
// In the specialist output handler, accumulate text
let accumulatedText = ''
// ... on each chunk:
if (chunk.type === 'text') accumulatedText += chunk.content

// Before marking task complete:
const detection = abandonmentDetector.detect(accumulatedText)
if (detection.detected) {
  // Don't mark complete — re-engage
  const reEngagement = abandonmentDetector.getReEngagementPrompt(detection, task.description)
  // Feed re-engagement prompt back to the specialist (or spawn new attempt with context)
  // This integrates with the Task Loop from Phase 2:
  // - Mark this iteration as "abandoned" (not "failed")
  // - Append re-engagement prompt to next iteration's context
  // - Count toward escalation threshold
}
```

#### 3.3 — Wire into Generalist

In `src/main/services/generalist.service.ts`, the generalist already accumulates text for handoff detection. Add abandonment detection alongside it:

```typescript
// After handoff detection logic:
const abandonment = this.abandonmentDetector.detect(this.accumulatedText)
if (abandonment.detected) {
  // For generalist: inject re-engagement via stdin
  const prompt = this.abandonmentDetector.getReEngagementPrompt(abandonment, currentTask)
  this.currentProcess.stdin.write(JSON.stringify({
    type: 'user',
    content: prompt
  }) + '\n')
  this.emit('abandonmentDetected', abandonment)
}
```

#### 3.4 — UI Indicator

Show a subtle indicator when abandonment is detected and re-engagement is triggered. Something like:
```
⚡ Agent attempted to give up — re-engaging with alternative approach
```

### Acceptance Criteria
- [ ] Specialist output is analyzed for abandonment patterns before marking complete
- [ ] Detected abandonment triggers re-engagement prompt (not task failure)
- [ ] Re-engagement prompt varies by category (direct, premature, deflection)
- [ ] Legitimate completion phrases are whitelisted and not blocked
- [ ] Abandonment events are logged in the database for analytics
- [ ] UI shows when re-engagement was triggered
- [ ] Integrates with Task Loop (Phase 2) — abandonment counts toward escalation

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/abandonment-detector.service.ts` |
| MODIFY | `src/main/services/specialist-pool.service.ts` — check before marking complete |
| MODIFY | `src/main/services/generalist.service.ts` — detect in accumulated text |
| MODIFY | `src/shared/constants.ts` — add `ABANDONMENT_DETECTED` IPC channel |
| MODIFY | `src/shared/types.ts` — add `AbandonmentDetection` interface |
| MODIFY | `src/renderer/src/components/chat/MessageBubble.tsx` — show re-engagement indicator |

---

## Phase 4: File-Based Agent Communication Chain

### Goal
Instead of passing all context through the LLM context window, have each specialist write structured output to a shared task directory. Subsequent specialists read prior outputs explicitly. This makes workflows auditable, resumable, and debuggable.

### Reference Code
- **wshobson/agents file chain**: `~/Downloads/external repos/agents/plugins/full-stack-orchestration/commands/full-stack-feature.md` — Each step writes to `.full-stack-feature/01-requirements.md`, next step reads it
- **wshobson/agents state file**: The `state.json` pattern with `current_step`, `completed_steps`, `files_created`
- **Multi-Agent Squad status files**: `~/Downloads/external repos/multi-agent-squad/` — PROJECT_STATUS.md, `.feature-*` tracking files

### Current State in AgentStudio
- `src/main/services/orchestrator.service.ts` passes task description directly to specialists via `claude -p` prompt. No file-based context passing.
- `src/main/services/specialist-pool.service.ts` manages parallel/sequential execution but specialists don't share intermediate artifacts.
- `src/main/db/schema.sql` has `conversation_file_changes` tracking created/modified/deleted files, but this is observational, not prescriptive.

### What to Build

#### 4.1 — Task Artifact Directory

For each task plan execution, create a shared artifact directory:

```
{workspace}/.agentstudio/
  {conversation-id}/
    state.json                    # Overall execution state
    tasks/
      {task-id}/
        input.md                  # Task description + context from prior tasks
        output.md                 # Specialist's structured output
        gate-results.json         # Quality gate results (from Phase 2)
        iterations.json           # Task loop history (from Phase 2)
```

#### 4.2 — Task Artifact Service

Create: `src/main/services/task-artifact.service.ts`

```typescript
// Reference: wshobson/agents state.json pattern
//
// State file tracks:
//   feature, status, current_step, current_phase,
//   completed_steps, files_created, started_at, last_updated

export interface TaskArtifactState {
  planId: string
  conversationId: string
  status: 'in_progress' | 'complete' | 'failed' | 'paused'
  currentTaskIndex: number
  completedTasks: string[]
  failedTasks: string[]
  artifacts: Record<string, string>  // taskId → output file path
  startedAt: string
  lastUpdated: string
}

export class TaskArtifactService {
  // Initialize artifact directory for a task plan
  async initialize(workspacePath: string, conversationId: string, plan: TaskPlan): Promise<void>

  // Write task input (description + context from prior outputs)
  async writeTaskInput(taskId: string, content: string): Promise<string>

  // Write task output (specialist's structured result)
  async writeTaskOutput(taskId: string, content: string): Promise<string>

  // Read prior task outputs for building context
  async readPriorOutputs(taskId: string, dependencies: string[]): Promise<string>

  // Update state file
  async updateState(update: Partial<TaskArtifactState>): Promise<void>

  // Read state for resumption
  async readState(workspacePath: string, conversationId: string): Promise<TaskArtifactState | null>

  // Clean up artifacts after successful merge
  async cleanup(workspacePath: string, conversationId: string): Promise<void>
}
```

#### 4.3 — Wire into Specialist Pool

In `src/main/services/specialist-pool.service.ts`, before spawning each specialist:

```typescript
// 1. Gather outputs from dependency tasks
const priorContext = await taskArtifactService.readPriorOutputs(
  task.id,
  task.dependencies
)

// 2. Build enriched prompt with prior context
const enrichedDescription = `
## Task
${task.description}

## Context from Prior Tasks
${priorContext}

## Output Requirements
Write a structured summary of your work to help downstream tasks understand what was implemented.
Include: files modified, key decisions made, API signatures created, test coverage added.
`

// 3. After specialist completes, extract and save output
// Parse the specialist's accumulated text for structured output
await taskArtifactService.writeTaskOutput(task.id, accumulatedText)
```

#### 4.4 — Session Resumption

When a conversation is reopened, check for existing artifact state:

```typescript
const existingState = await taskArtifactService.readState(workspacePath, conversationId)
if (existingState && existingState.status === 'in_progress') {
  // Offer to resume from where we left off
  // Skip completed tasks, resume from currentTaskIndex
}
```

This is a major UX improvement — users can close the app and resume complex multi-task workflows.

### Acceptance Criteria
- [ ] Each task plan creates a `.agentstudio/{conversation-id}/` directory
- [ ] Each specialist's output is saved as a structured markdown file
- [ ] Downstream specialists receive prior task outputs as context
- [ ] State file tracks progress and enables resumption
- [ ] User can close app and resume a multi-task workflow
- [ ] Artifact cleanup happens after successful completion
- [ ] Artifacts are human-readable (markdown, not binary)

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/task-artifact.service.ts` |
| MODIFY | `src/main/services/specialist-pool.service.ts` — read/write artifacts |
| MODIFY | `src/main/services/orchestrator.service.ts` — initialize artifacts on plan creation |
| MODIFY | `src/shared/types.ts` — add `TaskArtifactState` |
| MODIFY | `src/main/ipc/chat.ipc.ts` — expose resume capability |

---

## Phase 5: Cost Tracking Dashboard

### Goal
Track token usage and estimated cost per model, per agent, per conversation. Show users how much they're spending and how much model routing (Phase 1) is saving them.

### Reference Code
- **DevTeam cost tracking**: `~/Downloads/external repos/devteam/scripts/schema.sql` — `sessions` table with `total_tokens_input`, `total_tokens_output`, `total_cost_cents`; `events` table for per-agent tracking
- **DevTeam cost tracking script**: `~/Downloads/external repos/devteam/scripts/cost-tracking.sh`

### Current State in AgentStudio
- `src/main/services/agent-base.service.ts` already tracks token usage via `message_delta` and `message_stop` events. Accumulates `inputTokens` and `outputTokens`.
- `src/main/db/schema.sql` has `agent_sessions` table with `token_usage TEXT` (JSON string with input/output counts).
- `src/main/db/repositories/agent-session.repository.ts` persists sessions with token data.
- **What's missing**: No cost calculation, no per-model rates, no aggregate views, no UI dashboard.

### What to Build

#### 5.1 — Cost Calculator

Create: `src/main/services/cost-calculator.service.ts`

```typescript
// Anthropic API pricing (as of 2025, update as needed):
const MODEL_PRICING = {
  'claude-opus-4-20250514':   { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-haiku-4-20250414':  { inputPer1M: 0.80,  outputPer1M: 4.00 },
}

export interface CostBreakdown {
  totalCostCents: number
  byModel: Record<string, { inputTokens: number, outputTokens: number, costCents: number }>
  byAgent: Record<string, { inputTokens: number, outputTokens: number, costCents: number }>
  savingsVsAllOpus: number  // estimated savings from model routing
}

export class CostCalculator {
  // Calculate cost for a single session
  calculateSessionCost(tokens: { input: number, output: number }, model: string): number

  // Aggregate costs for a conversation
  getConversationCost(conversationId: string): Promise<CostBreakdown>

  // Aggregate costs for a workspace (all time or date range)
  getWorkspaceCost(workspaceId: string, since?: Date): Promise<CostBreakdown>

  // Calculate theoretical savings vs. all-opus
  calculateSavings(breakdown: CostBreakdown): number
}
```

#### 5.2 — IPC Endpoints

```typescript
// In src/shared/constants.ts:
COST_GET_CONVERSATION: 'cost:get:conversation',
COST_GET_WORKSPACE: 'cost:get:workspace',
COST_GET_SUMMARY: 'cost:get:summary',
```

#### 5.3 — UI: Cost Summary Component

Create a cost summary component shown in:
1. **Conversation header**: Small badge showing current conversation cost
2. **Workspace settings**: Full cost dashboard with:
   - Total spend by model (pie chart or bar)
   - Cost per conversation (table)
   - Savings from model routing (highlight number)
   - Token usage trends (sparkline)
3. **Task progress**: Per-task cost next to each specialist task

#### 5.4 — Budget Alerts

Optional workspace setting: `maxBudgetCents`. When cost exceeds threshold:
- 80% — yellow warning in UI
- 100% — block new specialist executions, show alert

Reference: DevTeam task-loop.md checks `if < 20% budget remaining, skip escalation`.

### Acceptance Criteria
- [ ] Every agent session records model used and token counts
- [ ] Cost is calculated using current Anthropic pricing per model
- [ ] Conversation-level cost breakdown is available in the UI
- [ ] Workspace-level cost dashboard shows spend by model and by agent
- [ ] "Savings vs all-Opus" metric is displayed
- [ ] Optional budget alerts at 80% and 100% thresholds

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/cost-calculator.service.ts` |
| CREATE | `src/main/ipc/cost.ipc.ts` |
| CREATE | `src/renderer/src/components/settings/CostDashboard.tsx` |
| CREATE | `src/renderer/src/store/cost.store.ts` |
| MODIFY | `src/shared/constants.ts` — add cost IPC channels |
| MODIFY | `src/shared/types.ts` — add CostBreakdown, budget types |
| MODIFY | `src/main/db/repositories/agent-session.repository.ts` — add aggregation queries |
| MODIFY | `src/renderer/src/components/agents/TaskProgress.tsx` — show per-task cost |

---

## Phase 6: Human Checkpoint UI

### Goal
Add explicit approval gates in the UI before critical actions: merging worktrees, executing multi-task plans, deploying. The user sees a summary of what will happen and must approve.

### Reference Code
- **wshobson/agents checkpoints**: `~/Downloads/external repos/agents/plugins/full-stack-orchestration/commands/full-stack-feature.md` — "PHASE CHECKPOINT 1 — User Approval Required. Do NOT proceed until user selects option 1."
- **Multi-Agent Squad human gates**: `~/Downloads/external repos/multi-agent-squad/.claude/hooks/enterprise-workflow.toml` — `⚠️ CRITICAL DECISION:` pattern with What/Why/Risk
- **wshobson/agents conductor**: `~/Downloads/external repos/agents/plugins/conductor/commands/implement.md` — Phase completion requires explicit user approval

### Current State in AgentStudio
- `src/main/services/specialist-pool.service.ts` executes all tasks automatically once a plan is approved. No mid-execution checkpoints.
- `src/main/services/generalist.service.ts` handles handoff detection and automatically routes to orchestrator. User approves the initial plan but has no control during execution.
- Worktree merging in `specialist-pool.service.ts` happens automatically on completion.

### What to Build

#### 6.1 — Checkpoint Types

```typescript
// Reference: Multi-Agent Squad CRITICAL DECISION pattern
export interface Checkpoint {
  id: string
  type: 'phase_gate' | 'merge_approval' | 'deployment' | 'destructive_action'
  title: string
  summary: string
  details: {
    what: string          // What will happen
    why: string           // Why this checkpoint exists
    risk: string          // What could go wrong
    changedFiles?: string[]  // Files that were modified
    testResults?: string     // Summary of test results
  }
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}
```

#### 6.2 — Checkpoint Service

Create: `src/main/services/checkpoint.service.ts`

```typescript
export class CheckpointService extends EventEmitter {
  // Create a checkpoint and pause execution
  async requestApproval(checkpoint: Omit<Checkpoint, 'id' | 'status' | 'createdAt'>): Promise<boolean>

  // Called from UI when user approves/rejects
  async resolve(checkpointId: string, approved: boolean): Promise<void>
}
```

When `requestApproval` is called, it:
1. Creates the checkpoint record
2. Emits an IPC event to the renderer
3. Returns a Promise that resolves when the user approves/rejects
4. The specialist pool **pauses** at this point

#### 6.3 — Integration Points

**After all tasks in a phase complete** (specialist-pool.service.ts):
```typescript
// Reference: wshobson full-stack-feature.md phase checkpoints
if (currentPhase.tasks.every(t => t.status === 'complete')) {
  const approved = await checkpointService.requestApproval({
    type: 'phase_gate',
    title: `Phase ${currentPhase.index} Complete`,
    summary: `All ${currentPhase.tasks.length} tasks passed quality gates`,
    details: {
      what: `Proceed to Phase ${currentPhase.index + 1}: ${nextPhase.name}`,
      why: 'Ensures work is reviewed before building on top of it',
      risk: 'Proceeding without review may compound errors across phases',
      changedFiles: currentPhase.tasks.flatMap(t => t.modifiedFiles),
      testResults: currentPhase.gateReport.summary
    }
  })
  if (!approved) {
    // Pause execution, allow user to review and request changes
  }
}
```

**Before merging worktrees**:
```typescript
const approved = await checkpointService.requestApproval({
  type: 'merge_approval',
  title: 'Merge Specialist Worktrees',
  summary: `Merge ${worktrees.length} worktrees into main branch`,
  details: {
    what: 'Git merge of isolated specialist work into the main workspace',
    why: 'Merging changes is irreversible without manual git intervention',
    risk: 'Potential merge conflicts. Review changes before merging.',
    changedFiles: allModifiedFiles
  }
})
```

#### 6.4 — UI: Checkpoint Modal

Create a modal component that:
- Shows checkpoint title and summary
- Displays changed files (collapsible list)
- Shows test results if available
- Has "Approve" (green) and "Reject" (red) buttons
- Shows risk level with appropriate coloring
- Blocks further execution until resolved

### Acceptance Criteria
- [ ] Phase transitions require user approval
- [ ] Worktree merges require user approval
- [ ] Checkpoint modal shows what/why/risk details
- [ ] Changed files are listed in the checkpoint
- [ ] Execution pauses until checkpoint is resolved
- [ ] Rejected checkpoints allow the user to provide feedback
- [ ] Checkpoint history is persisted in the database

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/checkpoint.service.ts` |
| CREATE | `src/renderer/src/components/chat/CheckpointModal.tsx` |
| CREATE | `src/renderer/src/store/checkpoint.store.ts` |
| MODIFY | `src/shared/constants.ts` — add checkpoint IPC channels |
| MODIFY | `src/shared/types.ts` — add Checkpoint interface |
| MODIFY | `src/main/services/specialist-pool.service.ts` — insert checkpoints |
| MODIFY | `src/main/ipc/chat.ipc.ts` — register checkpoint handlers |

---

## Phase 7: Progressive Skill Loading

### Goal
Stop dumping all specialist knowledge into every prompt. Load skills in tiers: metadata always available, instructions on activation, code examples on demand. Reduces token usage and improves focus.

### Reference Code
- **wshobson/agents skill architecture**: `~/Downloads/external repos/agents/docs/agent-skills.md` — 146 skills with progressive disclosure tiers
- **wshobson/agents skill activation**: Skills activate via description matching, not explicit commands
- **AgentStudio current skill system**: `~/Downloads/AgentStudio/src/main/services/skill.service.ts` — imports full .md files, activates via Opus call

### Current State in AgentStudio
- `src/main/services/skill.service.ts` imports full markdown files (up to 500KB) and stores them in the `skills` table.
- `src/main/services/orchestrator.service.ts` has `matchSkill()` which uses an LLM call to semantically match a task to a skill, then injects the **entire skill content** into the specialist's prompt.
- Every matched skill = full content in context window, regardless of relevance level.

### What to Build

#### 7.1 — Skill Tier Structure

```typescript
// Reference: wshobson/agents three-tier progressive disclosure
//
// Tier 1 (Always loaded, ~50 tokens): Metadata
//   - name, description, activation keywords
//
// Tier 2 (Loaded on activation, ~500 tokens): Core instructions
//   - Key patterns, decision rules, approach guidance
//
// Tier 3 (Loaded on demand, full content): Resources
//   - Code examples, templates, reference implementations

export interface SkillTier {
  tier1: {
    name: string
    description: string
    keywords: string[]
  }
  tier2: string | null     // First section of the skill (up to ## heading)
  tier3: string            // Full content
}
```

#### 7.2 — Skill Parser

When importing a skill, parse it into tiers:

```typescript
function parseSkillTiers(content: string): SkillTier {
  const lines = content.split('\n')
  // Tier 1: Extract name from # heading, description from first paragraph
  // Tier 2: Content up to the first ## subsection (core instructions)
  // Tier 3: Full content
}
```

#### 7.3 — Smart Skill Matching

In `src/main/services/orchestrator.service.ts`, change `matchSkill()` to:

1. **First pass**: Match against Tier 1 metadata (fast, no LLM call needed for obvious matches based on keywords)
2. **Second pass**: If multiple matches, use LLM with Tier 2 content to pick the best match
3. **Inject only what's needed**: For a specialist prompt, inject Tier 2 (instructions) by default. Only inject Tier 3 if the task specifically needs code examples.

#### 7.4 — Database Changes

```sql
ALTER TABLE skills ADD COLUMN tier1_summary TEXT;    -- JSON: name, description, keywords
ALTER TABLE skills ADD COLUMN tier2_instructions TEXT; -- First section of content
-- tier3 is the existing full content column
```

### Acceptance Criteria
- [ ] Skills are parsed into 3 tiers on import
- [ ] Skill matching uses Tier 1 keywords first (no LLM call for obvious matches)
- [ ] Specialist prompts receive Tier 2 by default, Tier 3 only when needed
- [ ] Token usage reduction is measurable (track tokens per skill injection)
- [ ] Existing skills are migrated to tiered structure on upgrade

### Files to Create/Modify
| Action | File |
|--------|------|
| MODIFY | `src/main/services/skill.service.ts` — add tier parsing, smart loading |
| MODIFY | `src/main/services/orchestrator.service.ts` — tiered matching |
| MODIFY | `src/main/db/schema.sql` — add tier columns |
| MODIFY | `src/main/db/repositories/skill.repository.ts` — persist tiers |
| MODIFY | `src/shared/types.ts` — add SkillTier interface |

---

## Phase 8: Scope Enforcement Layer

### Goal
Prevent specialists from modifying files outside their assigned task scope. Add file-pattern restrictions on top of the existing worktree isolation.

### Reference Code
- **DevTeam scope validator**: `~/Downloads/external repos/devteam/agents/orchestration/scope-validator.md` — 6-layer enforcement with VETO power, forbidden files/directories, allowed patterns, max files changed
- **DevTeam scope check hook**: `~/Downloads/external repos/devteam/hooks/scope-check.sh` — Pre-commit scope validation

### Current State in AgentStudio
- `src/main/services/specialist-pool.service.ts` creates worktrees for isolation (good), but no file-pattern restrictions within the worktree.
- `src/main/db/schema.sql` has `conversation_file_changes` table tracking what was modified, but only observationally (after the fact).

### What to Build

#### 8.1 — Scope Definition

Extend `DecomposedTask` with scope constraints:

```typescript
// Reference: DevTeam scope-validator.md
export interface TaskScope {
  allowedFiles?: string[]        // Exact paths: ["src/auth/login.ts"]
  allowedPatterns?: string[]     // Globs: ["src/auth/**/*.ts", "tests/auth/**/*.ts"]
  forbiddenDirectories?: string[] // ["src/billing/", "src/admin/"]
  forbiddenFiles?: string[]      // ["src/config/secrets.ts"]
  maxFilesChanged?: number       // e.g., 10
}
```

#### 8.2 — Scope Validator Service

Create: `src/main/services/scope-validator.service.ts`

```typescript
// Reference: DevTeam scope-validator.md validation logic
//
// Validation priority:
//   1. Check forbidden files FIRST (highest priority)
//   2. Check forbidden directories
//   3. Check explicitly allowed files
//   4. Check glob patterns
//   5. NOT explicitly allowed = FAIL

export class ScopeValidator {
  // Validate a set of changed files against scope
  validate(changedFiles: string[], scope: TaskScope): ScopeValidationResult

  // Extract changed files from specialist output (git diff)
  async getChangedFiles(worktreePath: string): Promise<string[]>

  // Post-execution validation: check what the specialist actually modified
  async validatePostExecution(worktreePath: string, scope: TaskScope): Promise<ScopeValidationResult>
}

export interface ScopeValidationResult {
  valid: boolean
  violations: Array<{
    file: string
    reason: 'forbidden_file' | 'forbidden_directory' | 'not_allowed' | 'max_files_exceeded'
  }>
  allowedChanges: string[]
  totalFilesChanged: number
}
```

#### 8.3 — Integration Points

1. **In orchestrator decompose()**: Generate scope for each task based on its description
2. **In specialist prompt**: Include scope as instructions ("You may ONLY modify files in: ...")
3. **Post-execution**: Validate changed files. If violations found, revert violating files and re-run
4. **In task loop (Phase 2)**: Scope violation = gate failure, triggers retry

#### 8.4 — Scope Auto-Generation

The orchestrator should auto-generate reasonable scope constraints during decomposition:

```typescript
// In DECOMPOSITION_SYSTEM_PROMPT, add:
// "For each task, define scope.allowedPatterns based on the task domain.
//  Backend API tasks: src/api/**, src/services/**, tests/api/**
//  Frontend tasks: src/components/**, src/pages/**, tests/components/**
//  Database tasks: src/db/**, migrations/**, tests/db/**"
```

### Acceptance Criteria
- [ ] Each decomposed task has a scope definition
- [ ] Specialist prompts include scope instructions
- [ ] Post-execution validation checks changed files against scope
- [ ] Scope violations are treated as gate failures in the task loop
- [ ] Violating file changes are reverted (git checkout) before retry
- [ ] Scope violations are logged for debugging

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/scope-validator.service.ts` |
| MODIFY | `src/shared/types.ts` — add TaskScope, ScopeValidationResult |
| MODIFY | `src/main/services/orchestrator.service.ts` — generate scopes in decompose |
| MODIFY | `src/main/services/specialist-pool.service.ts` — validate post-execution |
| MODIFY | `src/main/services/task-loop.service.ts` — scope violation = gate failure |
| MODIFY | `src/main/services/system-prompts.ts` — add scope instructions to specialist prompt |

---

## Phase 9: Declarative Hooks System

### Goal
Let users define automation hooks in a config file (YAML/TOML) instead of hardcoding behavior. Hooks trigger on events like "specialist completed", "tests failed", "file written" and run shell commands or inject prompts.

### Reference Code
- **Multi-Agent Squad TOML hooks**: `~/Downloads/external repos/multi-agent-squad/.claude/hooks/enterprise-workflow.toml` — Full declarative hook system with PreToolUse, PostToolUse, UserPromptSubmit events, blocking/non-blocking modes
- **Multi-Agent Squad dynamic generation**: `~/Downloads/external repos/multi-agent-squad/scripts/generate-hooks.py` — Generate hooks based on project type
- **DevTeam hooks.json**: `~/Downloads/external repos/devteam/hooks/hooks.json` — JSON-based hook configuration

### Current State in AgentStudio
- No user-configurable hook system. All behavior is hardcoded in services.
- The Electron lifecycle (app ready, before quit) handles app-level events.
- No way for users to run custom commands on agent events.

### What to Build

#### 9.1 — Hook Configuration Format

Users create `.agentstudio/hooks.yaml` in their workspace:

```yaml
# Reference: Multi-Agent Squad enterprise-workflow.toml adapted for AgentStudio
hooks:
  # Run after any specialist completes
  - event: specialist_complete
    name: "Auto-format code"
    command: "npx prettier --write ."
    blocking: false           # Don't block execution
    condition:
      mode: build             # Only in build mode

  # Run after quality gates
  - event: gate_failed
    name: "Notify on test failure"
    command: "echo 'Tests failed' | notify-send"
    blocking: false

  # Run before worktree merge
  - event: pre_merge
    name: "Final lint check"
    command: "npm run lint"
    blocking: true            # Block merge if lint fails

  # Run on task plan creation
  - event: plan_created
    name: "Log plan to file"
    command: "echo '${PLAN_SUMMARY}' >> .agentstudio/plan-history.log"
    blocking: false
```

#### 9.2 — Hook Engine

Create: `src/main/services/hook-engine.service.ts`

```typescript
export type HookEvent =
  | 'specialist_start'
  | 'specialist_complete'
  | 'specialist_failed'
  | 'gate_passed'
  | 'gate_failed'
  | 'escalation'
  | 'pre_merge'
  | 'post_merge'
  | 'plan_created'
  | 'checkpoint_approved'
  | 'checkpoint_rejected'
  | 'abandonment_detected'
  | 'task_loop_complete'

export interface HookDefinition {
  event: HookEvent
  name: string
  command: string            // Shell command to run
  blocking: boolean          // If true, block the event until command completes
  condition?: {
    mode?: 'plan' | 'build'
    model?: string
    agent?: string
  }
  timeout?: number           // ms, default 30000
}

export class HookEngine {
  // Load hooks from workspace config
  async loadHooks(workspacePath: string): Promise<HookDefinition[]>

  // Execute all hooks for an event
  async executeHooks(event: HookEvent, context: Record<string, string>): Promise<HookResult[]>

  // Generate default hooks based on project type
  // Reference: multi-agent-squad generate-hooks.py
  async generateDefaultHooks(workspacePath: string): Promise<HookDefinition[]>
}
```

#### 9.3 — Wire into Services

Add hook trigger points throughout existing services:

```typescript
// In specialist-pool.service.ts:
await hookEngine.executeHooks('specialist_complete', { taskId, agentId, model })

// In task-loop.service.ts:
await hookEngine.executeHooks('gate_failed', { taskId, failedGates: gates.join(',') })
await hookEngine.executeHooks('escalation', { from: oldModel, to: newModel })

// In checkpoint.service.ts:
await hookEngine.executeHooks('checkpoint_approved', { checkpointId, type })
```

#### 9.4 — UI: Hook Management

In workspace settings, show:
- Active hooks with their events and commands
- Hook execution history (last run, status, output)
- "Generate defaults" button that creates hooks based on detected project type

### Acceptance Criteria
- [ ] Users can define hooks in `.agentstudio/hooks.yaml`
- [ ] Hooks fire on the correct events
- [ ] Blocking hooks pause execution until the command completes
- [ ] Non-blocking hooks run in the background
- [ ] Hook failures are logged and surfaced in the UI
- [ ] Default hooks can be auto-generated based on project type
- [ ] Variables are interpolated into hook commands

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/hook-engine.service.ts` |
| CREATE | `src/renderer/src/components/settings/HookManager.tsx` |
| MODIFY | `src/main/services/specialist-pool.service.ts` — add hook trigger points |
| MODIFY | `src/main/services/task-loop.service.ts` — add hook trigger points |
| MODIFY | `src/main/services/checkpoint.service.ts` — add hook trigger points |
| MODIFY | `src/shared/types.ts` — add HookDefinition, HookEvent, HookResult |
| MODIFY | `src/shared/constants.ts` — add hook IPC channels |

---

## Phase 10: Deep Agent Personas & Bug Council

### Goal
Enrich specialist definitions with deep expertise (war stories, red flags, philosophy). Add a Bug Council pattern where 5 diagnostic agents collaborate when a specialist fails at the highest model tier.

### Reference Code
- **Multi-Agent Squad personas**: `~/Downloads/external repos/multi-agent-squad/.claude/agents/` — 100+ line personas with war stories, lessons learned, red flags
- **DevTeam Bug Council**: `~/Downloads/external repos/devteam/agents/diagnosis/` — 5 diagnostic agents (root-cause-analyst, code-archaeologist, pattern-matcher, systems-thinker, adversarial-tester)
- **DevTeam Bug Council orchestrator**: `~/Downloads/external repos/devteam/agents/orchestration/bug-council-orchestrator.md`

### Current State in AgentStudio
- `src/main/db/schema.sql` has `specialists` table with `prompt TEXT` field for agent definitions. These are typically short.
- `src/main/services/system-prompts.ts` has `SPECIALIST_TASK_SYSTEM_PROMPT` which is generic (3 lines).
- No diagnostic/council pattern exists.

### What to Build

#### 10.1 — Deep Persona Templates

Create enriched default specialist prompts. Reference the multi-agent-squad agents directory for structure:

```typescript
// Reference: multi-agent-squad agent persona structure:
//   1. Role & Experience (who you are)
//   2. Core Expertise (what you know)
//   3. War Stories (lessons from production)
//   4. Red Flags (what you catch that others miss)
//   5. Code Patterns (your preferred approaches)
//   6. Philosophy (how you think)
//   7. Promises (quality commitments)

export const DEEP_PERSONA_TEMPLATE = `
## Role
You are a {role} with {years}+ years of experience building production systems.

## Core Expertise
{expertise_bullets}

## Lessons from Production
{war_stories}

## Red Flags You Catch
{red_flags}

## Your Approach
{code_patterns}

## Philosophy
{philosophy}

## Quality Commitments
- I never ship code without tests
- I always check for security implications
- I document non-obvious decisions
- I keep changes focused and minimal
`
```

#### 10.2 — Bug Council Service

Create: `src/main/services/bug-council.service.ts`

```typescript
// Reference: DevTeam diagnosis agents
//
// 5 diagnostic perspectives:
//   1. Root Cause Analyst — Error analysis, hypothesis generation
//   2. Code Archaeologist — Git history, regression detection
//   3. Pattern Matcher — Similar bugs, anti-pattern identification
//   4. Systems Thinker — Dependencies, architectural issues
//   5. Adversarial Tester — Edge cases, security vulnerabilities
//
// Activation triggers (from DevTeam task-loop.md):
//   - 3+ consecutive opus failures
//   - Explicit user request
//   - Stuck loop detection

export interface BugCouncilResult {
  analyses: Array<{
    perspective: string
    findings: string
    confidence: number
  }>
  synthesizedSolution: string
  recommendedApproach: string
  riskAssessment: string
}

export class BugCouncilService extends EventEmitter {
  // Activate Bug Council when specialist has failed at opus level
  async convene(params: {
    taskDescription: string
    failureHistory: string[]      // All error outputs from previous attempts
    changedFiles: string[]
    workspacePath: string
  }): Promise<BugCouncilResult>
}
```

**Implementation**: Spawn 5 parallel `claude -p` calls (using haiku for cost efficiency — analysis is text-heavy, not code-heavy), each with a different diagnostic persona prompt. Collect their outputs, then make a final synthesis call (sonnet) to combine perspectives into an actionable solution.

#### 10.3 — Wire Bug Council into Task Loop

In `src/main/services/task-loop.service.ts`:

```typescript
// When opus fails 3x:
if (state.currentModel === 'opus' && state.consecutiveFailures >= config.opusMaxFailures) {
  // Activate Bug Council
  this.emit('bugCouncilActivated', { taskId, failures: state.failureHistory })
  const councilResult = await bugCouncilService.convene({
    taskDescription: task.description,
    failureHistory: state.failureHistory.map(f => f.errorSummary),
    changedFiles: getChangedFiles(worktreePath),
    workspacePath
  })
  // Use synthesized solution as the next attempt's context
  task.description += `\n\n## Bug Council Analysis\n${councilResult.synthesizedSolution}`
  // One more attempt with the council's guidance
}
```

#### 10.4 — UI: Bug Council Panel

When Bug Council is active, show a panel with:
- Each analyst's perspective (collapsible cards)
- Synthesized solution (highlighted)
- Recommended approach
- "Approve & retry" / "Escalate to human" buttons

### Acceptance Criteria
- [ ] Default specialists have enriched personas (war stories, red flags, philosophy)
- [ ] Bug Council activates after 3 opus failures in the task loop
- [ ] 5 diagnostic agents run in parallel with different perspectives
- [ ] Perspectives are synthesized into an actionable solution
- [ ] Solution is fed back to the specialist for one more attempt
- [ ] Bug Council results are shown in the UI
- [ ] Bug Council activation is logged in the database

### Files to Create/Modify
| Action | File |
|--------|------|
| CREATE | `src/main/services/bug-council.service.ts` |
| CREATE | `src/renderer/src/components/agents/BugCouncilPanel.tsx` |
| MODIFY | `src/main/services/task-loop.service.ts` — trigger Bug Council |
| MODIFY | `src/main/services/system-prompts.ts` — add deep persona template + 5 council prompts |
| MODIFY | `src/shared/types.ts` — add BugCouncilResult |
| MODIFY | `src/shared/constants.ts` — add Bug Council IPC channels |
| MODIFY | `src/main/db/schema.sql` — add `bug_council_sessions` table |

---

## Implementation Order & Dependencies

```
Phase 1: Complexity Scoring & Model Routing ← NO dependencies, start here
    ↓
Phase 2: Task Loop with Quality Gates ← depends on Phase 1 (model escalation)
    ↓
Phase 3: Anti-Abandonment Detection ← depends on Phase 2 (integrates with loop)
    ↓
Phase 5: Cost Tracking Dashboard ← depends on Phase 1 (model tracking)

Phase 4: File-Based Agent Communication ← independent, can start in parallel
Phase 6: Human Checkpoint UI ← independent, can start in parallel
Phase 7: Progressive Skill Loading ← independent, can start in parallel

Phase 8: Scope Enforcement ← depends on Phase 2 (scope = gate in loop)
Phase 9: Declarative Hooks ← depends on Phases 2, 3, 6 (hook trigger points)
Phase 10: Bug Council ← depends on Phase 2 (activated by task loop)
```

### Suggested Sprint Plan

| Sprint | Phases | Focus |
|--------|--------|-------|
| Sprint 1 | **Phase 1 + 5** | Model routing + cost visibility (quick wins, immediate savings) |
| Sprint 2 | **Phase 2 + 3** | Task loop + anti-abandonment (reliability core) |
| Sprint 3 | **Phase 4 + 6** | Artifacts + checkpoints (auditability + control) |
| Sprint 4 | **Phase 7 + 8** | Skill optimization + scope enforcement (efficiency + safety) |
| Sprint 5 | **Phase 9 + 10** | Hooks + Bug Council (extensibility + advanced diagnostics) |

---

## Quick Reference: Where to Find Patterns

| Pattern | Project | File Path |
|---------|---------|-----------|
| Complexity scoring (0-14) | DevTeam | `agents/orchestration/task-loop.md` |
| Task loop iterations | DevTeam | `agents/orchestration/task-loop.md` |
| Quality gate commands per language | DevTeam | `agents/orchestration/quality-gate-enforcer.md` |
| Model escalation config | DevTeam | `.devteam/task-loop-config.yaml` |
| Scope validation with VETO | DevTeam | `agents/orchestration/scope-validator.md` |
| Anti-abandonment regex patterns | DevTeam | `hooks/persistence-hook.sh` |
| SQLite state schema | DevTeam | `scripts/schema.sql` |
| Bug Council 5 analysts | DevTeam | `agents/diagnosis/*.md` |
| Cost tracking tables | DevTeam | `scripts/schema.sql` (sessions table) |
| File-based output chain | wshobson/agents | `plugins/full-stack-orchestration/commands/full-stack-feature.md` |
| State.json resumption | wshobson/agents | Same file (state management section) |
| Progressive skill tiers | wshobson/agents | `docs/agent-skills.md` |
| Conductor TDD workflow | wshobson/agents | `plugins/conductor/commands/implement.md` |
| Model tier assignments | wshobson/agents | `docs/agents.md` |
| Phase checkpoints | wshobson/agents | `plugins/full-stack-orchestration/commands/full-stack-feature.md` |
| TOML declarative hooks | Multi-Agent Squad | `.claude/hooks/enterprise-workflow.toml` |
| Dynamic hook generation | Multi-Agent Squad | `scripts/generate-hooks.py` |
| Deep agent personas | Multi-Agent Squad | `.claude/agents/*/*.md` |
| Git worktree orchestration | Multi-Agent Squad | `scripts/worktree-manager.sh` |
| Human checkpoint pattern | Multi-Agent Squad | `.claude/hooks/enterprise-workflow.toml` |
| Enterprise Agile workflow | Multi-Agent Squad | `docs/AGILE_WORKFLOW.md` |

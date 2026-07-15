# E2E Master Test Suite Catalog

> **Status**: 128 implemented scenarios across 17 categories. This catalog documents the
> full feature surface of Code Atelier / build.unosquare, grouping tests by product area.
> Each section lists **existing** scenarios (✅) and **gaps** (🔲) that should be added.
>
> Generated: 2026-07-15

---

## 1. Chat Core (25 scenarios ✅)

Basic chat capabilities — the LLM conversation pipeline.

| ID | Title | Status | Assertions |
|---|---|---|---|
| `chat-core.basic-completion` | Basic Completion | ✅ | streamCompleted, responseMinLength, noErrorChunks |
| `chat-core.multi-turn-context` | Multi-Turn Context | ✅ | responseMatches (context recall) |
| `chat-core.streaming-chunks` | Streaming Chunks | ✅ | streamCompleted, responseMinLength |
| `chat-core.structured-json` | Structured JSON | ✅ | validJson |
| `chat-core.tool-error-recovery` | Tool Error Recovery | ✅ | responseExists |
| `chat-core.instruction-following` | Instruction Following | ✅ | responseMatches |
| `chat-core.mermaid-diagram` | Mermaid Diagram | ✅ | responseHasMermaidBlock |
| `chat-core.markdown-table` | Markdown Table | ✅ | responseHasMarkdownTable |
| `chat-core.code-generation` | Code Generation | ✅ | responseMatches (function keyword) |
| `chat-core.thinking-visible` | Thinking Visibility | ✅ | responseMatches (reasoning + answer) |
| `chat-core.vision-image-read` | Vision — Text Read | ✅ | responseMatches (APEX-42 OCR) |
| `chat-core.mode-switching` | Mode Switching | ✅ | toolCalled (after switch) |
| `chat-core.stop-generation` | Stop Generation | ✅ | responseMaxLength |
| `chat-core.manual-compaction` | Manual Compaction | ✅ | statusEntryMatches (compaction) |
| `chat-core.danger-mode` | Danger Mode | ✅ | toolCalled (Bash in danger) |
| `chat-core.effort-high` | High Effort Thinking | ✅ | responseMinLength(200), reasoning keywords |
| `chat-core.tone-caveman` | Caveman Tone | ✅ | responseBrevityCheck, content keywords |
| `chat-core.prompt-optimization` | Prompt Optimization | ✅ | promptOptimizerRan |
| `chat-core.prompt-optimization-parse-resilience` | Parse Resilience | ✅ | promptOptimizerChanged |
| `chat-core.prompt-optimization-skip-short` | Short Skip | ✅ | responseMinLength |
| `chat-core.context-usage-tracking` | Context Usage Tracking | ✅ | statusEntryMatches |
| `chat-core.long-context` | Long Context (needle) | ✅ | responseMatches (NEEDLE) |
| `chat-core.specialist-swap` | Specialist Swap | ✅ | responseMatches (persona) |
| `chat-core.mcp-override-local` | MCP Override | ✅ | responseMatches (capabilities) |
| `chat-core.resume-at` | Resume At Message | ✅ | responseMatches (PHOENIX) |

### Gaps — Chat Core
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `chat-core.tone-calm` | Calm tone | Verify warm, non-condescending style |
| 🔲 `chat-core.tone-optimistic` | Optimistic tone | Verify upside-framing, no "unfortunately" |
| 🔲 `chat-core.tone-brutal` | Brutal tone | Verify zero-filler, direct criticism |
| 🔲 `chat-core.tone-default` | Default tone reset | Set caveman → default, verify style reverts |
| 🔲 `chat-core.multi-session` | Multiple concurrent sessions | Two chats streaming simultaneously |
| 🔲 `chat-core.workspace-switch` | Workspace switch mid-session | Switch workspace, verify context changes |
| 🔲 `chat-core.auto-compact` | Auto-compaction trigger | Fill context until auto-compact fires |
| 🔲 `chat-core.error-recovery-stream` | Stream error recovery | Force network error, verify retry/resume |

---

## 2. Tools (21 scenarios ✅)

MCP tool invocation — read, write, search, code intelligence.

| ID | Title | Status |
|---|---|---|
| `tools.read-file` | Read File | ✅ |
| `tools.write-file` | Write File | ✅ |
| `tools.grep-search` | Grep Search | ✅ |
| `tools.glob-search` | Glob Tool | ✅ |
| `tools.bash-execution` | Bash Tool | ✅ |
| `tools.edit-file` | Edit File | ✅ |
| `tools.multi-tool-chain` | Multi-Tool Chain | ✅ |
| `tools.code-graph-tools` | Code Graph Tools | ✅ |
| `tools.git-log` | Git Log | ✅ |
| `tools.git-diff` | Git Diff | ✅ |
| `tools.git-blame` | Git Blame | ✅ |
| `tools.todo-scanner` | TODO Scanner | ✅ |
| `tools.code-analysis` | Code Analysis | ✅ |
| `tools.checkpoint-list` | List Checkpoints | ✅ |
| `tools.semantic-search` | Semantic Search | ✅ |
| `tools.code-graph-deep` | Code Graph Deep | ✅ |
| `tools.tool-permission` | Permission Gating | ✅ |
| `tools.subagent-execution` | Subagent Execution | ✅ |
| `tools.eslint-check` | ESLint Check | ✅ |
| `tools.dependency-health` | Dependency Analysis | ✅ |
| `tools.web-search` | Web Search | ✅ |

### Gaps — Tools
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `tools.web-fetch` | Web Fetch | Verify URL content fetch |
| 🔲 `tools.checkpoint-create` | Checkpoint Create | Verify checkpoint creation flow |
| 🔲 `tools.checkpoint-restore` | Checkpoint Restore | Verify checkpoint rollback |
| 🔲 `tools.list-dir` | ListDir Tool | Verify directory listing |

---

## 3. Planning (6 scenarios ✅)

Plan emission, revision, build handoff.

| ID | Title | Status |
|---|---|---|
| `planning.emit-plan-card` | Emit Plan Card | ✅ |
| `planning.revise-plan` | Revise Plan | ✅ |
| `planning.build-after-plan` | Build After Plan | ✅ |
| `planning.plan-to-build-write` | Plan to Build — File Write | ✅ |
| `planning.ask-user-question` | Ask User Question | ✅ |
| `commands.audit` | Audit-style Review | ✅ |

### Gaps — Planning
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `planning.plan-rejection` | Plan rejection → replanning | Verify user can reject and get new plan |
| 🔲 `planning.multi-phase-plan` | Multi-phase plan execution | Verify phased plan with dependencies |

---

## 4. Memory (11 scenarios ✅)

Workspace knowledge — record, search, contradict, cross-conversation.

| ID | Title | Status |
|---|---|---|
| `memory.propose-memory` | Propose Memory | ✅ |
| `memory.search-memory` | Search Memory | ✅ |
| `memory.contradict-memory` | Contradict Memory | ✅ |
| `memory.memory-context` | Memory in Context | ✅ |
| + 7 more edge cases | (flag, promote, update, cross-workspace, etc.) | ✅ |

### Gaps — Memory
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `memory.tier-promotion` | Memory tier promotion | Verify Data→Info→Knowledge progression |
| 🔲 `memory.contradiction-resolution` | Contradiction resolution | Verify supersedes/archived handling |
| 🔲 `memory.doc-watcher` | Doc watcher extraction | Verify .md file change → memory extraction |
| 🔲 `memory.commit-extraction` | Commit message extraction | Verify git commit → memory extraction |

---

## 5. Commands (2 scenarios ✅)

Slash commands in the chat input.

| ID | Title | Status |
|---|---|---|
| `commands.recap` | /recap | ✅ |
| `commands.audit` | /audit | ✅ |

### Gaps — Commands
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `commands.goal` | /goal command | Verify goal creation from chat |
| 🔲 `commands.compact` | /compact command | Verify manual context compaction |
| 🔲 `commands.clear` | /clear command | Verify conversation clearing |
| 🔲 `commands.mode-plan` | /plan command | Verify mode switch via command |
| 🔲 `commands.mode-build` | /build command | Verify mode switch via command |
| 🔲 `commands.help` | /help command | Verify help output |

---

## 6. Grill Me (5 scenarios ✅)

Idea evaluation with iterative feedback.

| ID | Title | Status |
|---|---|---|
| `grill.evaluate-idea` | Evaluate Idea | ✅ |
| `grill.multi-track` | Multi-Track | ✅ (heavy) |
| `grill.iteration` | Grill Iteration | ✅ (heavy) |
| `grill.condense-requirement` | Condense Requirement | ✅ (heavy) |
| `grill.plan-and-resume` | Plan + Resume | ✅ (heavy) |

### Gaps — Grill Me
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `grill.greenfield-evaluation` | Greenfield (no workspace) | Verify evaluation without codebase context |
| 🔲 `grill.score-improvement` | Score improvement on iteration | Verify re-evaluation improves after feedback |
| 🔲 `grill.blueprint-handoff` | Grill → Blueprint pipeline | Verify idea promoted to blueprint |
| 🔲 `grill.track-scoring` | Track score structure | Verify track scores are valid (feasibility, impact, etc.) |

---

## 7. Blueprints (5 scenarios ✅)

Multi-phase blueprint pipeline — specify, clarify, plan, tasks, build, verify.

| ID | Title | Status |
|---|---|---|
| `blueprints.phase-management` | Phase Management | ✅ |
| `blueprints.progress-tracking` | Progress Tracking | ✅ |
| `blueprints.task-execution` | Task Execution | ✅ (heavy) |
| `blueprints.clarify-live` | Clarify Phase — Live LLM | ✅ (heavy) |
| `blueprints.state-persistence` | State Persistence | ✅ |

### Gaps — Blueprints
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `blueprints.full-pipeline` | Full specify→verify pipeline | End-to-end blueprint lifecycle |
| 🔲 `blueprints.build-phase` | Build phase execution | Verify code generation in build phase |
| 🔲 `blueprints.verify-phase` | Verify phase validation | Verify verification catches issues |
| 🔲 `blueprints.review-phase` | Review phase (council) | Verify peer review integration |
| 🔲 `blueprints.wave-execution` | Wave-based task execution | Verify parallel wave task groups |
| 🔲 `blueprints.error-recovery` | Phase failure recovery | Verify rewind/retry on phase failure |

---

## 8. MPA — Multi-Phased Agent (8 scenarios ✅)

Goal-driven pipeline — preflight, orchestration, campaigns.

| ID | Title | Status |
|---|---|---|
| `mpa.preflight` | Preflight Classification | ✅ |
| `mpa.goal-conditions` | Goal Conditions | ✅ |
| `mpa.orchestration` | Orchestration | ✅ (heavy) |
| `mpa.cancellation` | Cancellation | ✅ (heavy) |
| `mpa.campaign-sequential` | Campaign Sequential | ✅ (heavy) |
| + 3 more | (permission-escalation, context-handoff, etc.) | ✅ |

### Gaps — MPA
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `mpa.campaign-parallel` | Parallel campaign goals | Verify concurrent goal execution |
| 🔲 `mpa.gate-approval` | Human gate approval | Verify gate pause/resume flow |
| 🔲 `mpa.builder-write` | Builder phase file writes | Verify MPA builder creates files |

---

## 9. Council (4 scenarios ✅)

Multi-advisor review with structured verdict.

| ID | Title | Status |
|---|---|---|
| `council.start-session` | Session Start | ✅ (heavy) |
| `council.advisor-opinions` | Advisor Opinions | ✅ (heavy) |
| `council.structured-output` | Structured Output | ✅ (heavy) |
| `council.peer-review` | Peer Review | ✅ (heavy) |

### Gaps — Council
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `council.verdict-synthesis` | Chairman verdict synthesis | Verify final verdict format |
| 🔲 `council.advisor-diversity` | Advisor viewpoint diversity | Verify contrarian ≠ executor opinions |
| 🔲 `council.outsider-no-tools` | Outsider has no tools | Verify outsider can't read codebase |

---

## 10. Code Intelligence (3 scenarios ✅)

Code graph indexing, embedding, semantic search.

| ID | Title | Status |
|---|---|---|
| `code-intel.code-graph-index` | Code Graph Indexing | ✅ |
| `code-intel.embedding-generation` | Embedding Generation | ✅ |
| `code-intel.semantic-search` | Semantic Search | ✅ |

### Gaps — Code Intel
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `code-intel.incremental-index` | Incremental re-indexing | Verify file change → graph update |
| 🔲 `code-intel.dead-code` | Dead code detection | Verify find_dead_code results |

---

## 11. Audit (3 scenarios ✅)

Workspace health auditing.

| ID | Title | Status |
|---|---|---|
| `audit.start-run` | Start Audit Run | ✅ |
| `audit.findings` | Audit Findings | ✅ |
| `audit.coverage` | Audit Coverage | ✅ |

---

## 12. Chat Edge Cases (13 scenarios ✅)

Resilience scenarios — malformed input, error handling, boundary conditions.

| ID | Title | Status |
|---|---|---|
| `chat-edge.malformed-json-tool` | Malformed JSON Tool Args | ✅ |
| `chat-edge.compaction-boundary` | Compaction Boundary | ✅ |
| `chat-edge.backend-restart-resilience` | Backend Restart | ✅ (heavy) |
| + 10 more | (empty input, context overflow, concurrent stream, etc.) | ✅ |

### Gaps — Chat Edge
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `chat-edge.rate-limit` | Rate limit handling | Verify graceful 429 handling |
| 🔲 `chat-edge.token-limit-exceeded` | Token limit exceeded | Verify max_tokens handling |

---

## 13. Specialists (4 scenarios ✅)

Project specialist lifecycle — dispatch, evaluation, context.

| ID | Title | Status |
|---|---|---|
| `specialists.dispatch` | Specialist Dispatch | ✅ |
| `specialists.lifecycle` | Specialist Lifecycle | ✅ |
| + 2 more | (context handoff, swap-back) | ✅ |

---

## 14. Security (4 scenarios ✅)

Prompt injection, command refusal, system prompt protection.

| ID | Title | Status |
|---|---|---|
| `security.injection-instruction-override` | Injection Override | ✅ |
| `security.injection-file-read` | Injection via File | ✅ |
| `security.system-prompt-extraction` | Prompt Extraction | ✅ |
| `security.destructive-command-refusal` | Destructive Refusal | ✅ |

### Gaps — Security
| ID (proposed) | Feature | Why needed |
|---|---|---|
| 🔲 `security.ipc-sender-validation` | IPC sender validation | Verify validateSender blocks spoofing |
| 🔲 `security.sandbox-escape` | Sandbox escape attempt | Verify sandbox containment |
| 🔲 `security.data-exfiltration` | Data exfiltration guard | Verify secrets aren't leaked via tools |

---

## 15. Ideas (4 scenarios ✅)

Idea creation, listing, status transitions.

---

## 16. Checkpoints (4 scenarios ✅)

Checkpoint creation, listing, restoration.

---

## 17. Workspace Ops (6 scenarios ✅)

Workspace-level operations — commit messages, settings, etc.

---

## Summary

| Category | Implemented | Gaps (proposed) | Priority |
|---|---|---|---|
| Chat Core | 25 | 8 | 🔴 High — tone variants, multi-session |
| Tools | 21 | 4 | 🟡 Medium |
| Planning | 6 | 2 | 🟡 Medium |
| Memory | 11 | 4 | 🔴 High — tier promotion, doc watcher |
| Commands | 2 | 6 | 🔴 High — /goal, /compact missing |
| Grill Me | 5 | 4 | 🟡 Medium |
| Blueprints | 5 | 6 | 🔴 High — full pipeline untested |
| MPA | 8 | 3 | 🟡 Medium |
| Council | 4 | 3 | 🟡 Medium |
| Code Intel | 3 | 2 | 🟢 Low |
| Audit | 3 | 0 | ✅ Complete |
| Chat Edge | 13 | 2 | 🟢 Low |
| Specialists | 4 | 0 | ✅ Complete |
| Security | 4 | 3 | 🔴 High — sensitive area |
| Ideas | 4 | 0 | ✅ Complete |
| Checkpoints | 4 | 0 | ✅ Complete |
| Workspace Ops | 6 | 0 | ✅ Complete |
| **Total** | **128** | **47** | |

## Next Steps

1. **Phase 1 — Commands**: Add /goal, /compact, /clear, /plan, /build, /help scenarios
2. **Phase 2 — Tones**: Add calm, optimistic, brutal, default-reset scenarios
3. **Phase 3 — Blueprint Pipeline**: Full specify→verify end-to-end test
4. **Phase 4 — Memory Lifecycle**: Tier promotion, contradiction resolution, doc watcher
5. **Phase 5 — Security**: IPC validation, sandbox escape, data exfiltration guards

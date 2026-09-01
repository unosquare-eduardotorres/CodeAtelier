# Audit of `blueprint-execution-improvements.md`

**Date:** 2026-09-01. **Scope:** every code claim in the plan was re-verified against the working tree (HEAD `2d79fc28`, v1.0.97); every external claim was checked against primary sources (URLs at the end). Nothing in the codebase was changed.

**Read this before implementing anything in the plan.** The plan's catalog of ideas is sound and well chosen, but its picture of the Claude build path is wrong in a way that would send an implementer to the wrong file, and its phase ordering does not match what the commit log says is actually failing.

---

## 0. Verdict in one screen

| # | Item | Verdict | One-line reason |
|---|---|---|---|
| — | §1.3 baseline ("Claude path = `agentic-claude-runner.ts`") | **WRONG** | That runner serves Deep Scan / memory extraction only. Build tasks run through `AgentSessionService` → `cli-executor.ts`, which already uses `stream-json`, already captures `session_id`, already supports `--resume`. |
| A1 | Cache-friendly prompt ordering | **Mostly already done** | `blueprint-build.adapter.ts:53–67` ("Phase 1.2") already puts all task-specific text last. Remaining win is inside the task tail on *retries*, and only once retries resume a session (B1). Low yield; do not lead with it. |
| A2 | Relevance-ranked discoveries | **Keep** | Claim verified. Cheap, pure, testable. |
| A3 | Git commit per task | **Keep, reframe** | The prompt already *asks* the agent to commit per task (`build-phase.md:78–84`); nothing enforces it. Build it as a deterministic safety net that skips when the agent already committed. Landing stays manual. |
| A4 | Repo-map injection | **Keep, change source** | `repomap-mcp` is not imported anywhere in `src/`; the graph lives in `code-graph.service.ts` / `code-graph-edge.repository.ts` and is already indexed before wave 1 (`blueprint-build.service.ts:607–637`). Build the map from that, scoped to the shadow workspace. The package is single-maintainer, zero-adoption; do not take a runtime dependency on it. |
| B1 | Session resume on retry | **Keep, biggest win, different design** | Six of seven blueprint phases already resume on retry via `conversationRepository.getSessionId(priorConvId)`. Build is the odd one out because `executeTask` mints `blueprint-build-<bp>-<task>-<Date.now()>` per attempt (`:3104`). Fix the conversation id, not the output format. Same fix covers OpenCode (`getOrCreateSession` is keyed by the same id). |
| B2 | Task coalescing | **Keep, medium priority** | Prior art (Anthropic, Cognition, MAST) supports one context for state-sharing tasks. Must also handle the legacy `executeWave` scheduler, which the plan does not mention. |
| B3 | Handoff packets | **Keep, later** | Sound, but no measured evidence yet that caps are the binding constraint. Gate it on Phase 0 numbers. |
| C1 | AIMD parallelism | **Keep, needs a signal** | `recordParallelism` only fills a histogram. The clean input is the CLI's `system/api_retry` stream event (`error: rate_limit | overloaded`, `retry_delay_ms`). |
| C2 | Prefetch | **Defer** | Only matters after A2/A4 make assembly expensive. |
| D1 | Wave-boundary curator | **Keep, last** | Devin knowledge has no published benefit numbers. OpenHands condenser does (see §4). Cheap-model, once per wave, flagged: fine. |
| D2 | Research subagent | **Defer** | Architecture note in CLAUDE.md says no sub-agents; this is a separate process, not the Agent tool, but it adds LLM calls before any deterministic win is banked. |
| D3 | Quarantine lane | **Defer / possibly drop** | Correctness risk acknowledged in the plan. `saveRetryContext` fingerprinting (`blueprint.service.ts:1801–1858`) already detects non-converging retries; extend that first. |
| D4 | Provider breaker + failover | **Keep the breaker, drop failover for now** | The "existing breaker" is a 5-consecutive-error counter, not a half-open provider breaker. Cross-provider failover on Max vs local LLMs has a capability cliff. |
| — | Phase ordering | **Reorder** | Commit log is dominated by resiliency failures (stalls, event-bus wiring, misclassified transients, recovery turns), not token economics. See §3. |

---

## 1. Baseline corrections (facts the implementer must know)

### 1.1 The real Claude build path

```
blueprint-build.service.ts executeTask (:2952)
  → buildTaskContext (:3522)
  → new BlueprintBuildAdapter (:3006)  + new AgentSessionService (:3017)
  → session.send(adapter.getPhaseMessage(), syntheticConvId)   // :3143
      syntheticConvId = `blueprint-build-${blueprintId}-${task.taskId}-${Date.now()}`  // :3104
  → agent-session.service.ts:1728  sessionId = this.sessionMap.get(conversationId)  // always empty for a fresh id
  → cli-executor.ts buildCLIArgs (:1628–1703)
      claude --output-format stream-json --input-format stream-json --verbose
             --include-partial-messages --model … --permission-mode …
             --system-prompt-file <tmp> --max-turns … --mcp-config … --allowedTools … --disallowedTools …
             [--resume <id>]   // :1686–1699, guarded by markSessionPoisoned (:450) and UUID check
      session_id captured at :816 from system/init
```

Consequences:

- `agentic-claude-runner.ts` is irrelevant to the build path. Its callers are `memory-reflection`, `specialist-builder`, `memory-extraction`, `memory-bootstrap/executors`. Changing `buildClaudeArgs` there does nothing for builds.
- Build parses `parsePhaseCompletionBlock(session.getStreamedContent())` (`:3172`), not `parseSentinelBlock`. Plan open question 5.2 is moot.
- Build's MCP surface is code-graph, semantic-search, git-context, code-analysis, memory (`blueprint-build.adapter.ts:90–119`), not "memory + code-graph only".
- Because the build uses `--system-prompt-file`, the CLI's default system prompt (which embeds cwd, git status, platform) is replaced. The cross-task cacheable prefix is therefore `tools + our phase prompt`, which the adapter already keeps identical across tasks. This is good news for caching and means the `--exclude-dynamic-system-prompt-sections` flag is not needed.

### 1.2 Other stale or wrong anchors

- `buildSystemPrompt` (`blueprint.service.ts:1759`) is phase-scoped and contains nothing task-specific. There is nothing to reorder there.
- `enrichGitContext` is a private method of `opencode-executor.ts` (`:2024`), not in `blueprint.service.ts`.
- No `session_id` column exists on `blueprint_tasks`. Persisting one needs an ALTER migration (see `schema.sql:593` rule). Repository is `blueprint.repository.ts` (`setOutcome :670`, `setCompletion :719`, `recordAttempt :771`).
- Usage log already records `cache_read_tokens` / `cache_creation_tokens` per turn with `feature='blueprint-build'` and `conversation_id='blueprint-build-<bp>-<task>-<ts>'` (`agent-stream-processor.ts:106–115`, `usage-tracker.service.ts:14–31`). Phase 0 can be run today with a SQL query; no instrumentation work needed.
- A second scheduler, `executeWave` (`blueprint-build.service.ts:1423`), is still live as `wave-fallback` when the `dagScheduling` pref is off or the DAG has a cycle (`:651–705`). B2 and C1 must either cover it or explicitly exclude it.
- OpenCode primitives all exist but every line number in the plan is off by 100–500 lines (e.g. `getOrCreateSession` is `:2500` and private; `revertSession` `:2084`). `revertSession` wraps OpenCode's file-snapshot revert, not git.
- File sizes, service count (29 not 28), and `run-tests.ts` entry count (474 not 271) are all stale. Treat every line anchor in the plan as approximate.

### 1.3 Existing tests you can build on

- `blueprint-dag-scheduler.test.ts:204–500` already covers cross-wave dispatch, file-overlap serialisation, drain gates, cascade-skip readiness and cap. It is the harness for B2/C1.
- `buildTaskContext` is exercised in five test files; none assert ordering (plan is right about that).
- Dual registration in `src/main/services/__tests__/run-tests.ts` and `src/main/__tests__/run-all.ts` is confirmed.

---

## 2. Per-item audit with external evidence

### A1 — prompt ordering
- Code: outer ordering is already cache-optimal (`blueprint-build.adapter.ts:53–67`). Inside the task tail, the work packet sits between two volatile retry sections by explicit design (comment at `:3594`: retry reads "what went wrong" first).
- External: Anthropic's caching rules are tools → system → messages, changes invalidate everything after; minimum cacheable prefix is 1,024 tokens on Sonnet 5 / Opus 4.8 and 512 on Opus 5 / Fable 5.x. Claude Code applies breakpoints automatically; `-p` and SDK runs on a subscription get a 1-hour TTL (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h` to force). Parallel sessions in the same directory share cache; worktrees count as different directories.
- Verdict: keep as a 30-minute tidy-up after B1, not a phase.

### A2 — relevance-ranked discoveries
- Code: `priorDiscoveries.slice(-20)` (`:3554`), persisted as artifact type `'discoveries'` (`:2724–2729`). Verified.
- External: Anthropic's context-engineering post argues for just-in-time, identifier-led retrieval over pre-loading and warns about "context rot" as token count grows. Path-overlap ranking is the cheapest form of that.
- Verdict: keep. Pure function, unit test, fallback to recency.

### A3 — git commit per task
- Code: no deterministic commit anywhere in `blueprint*.ts`; only `git rev-parse` / diff reads. The build prompt already instructs a per-task commit protocol (`src/main/blueprints/prompts/build-phase.md:78–84`, adapter `getPhaseMessage :70–79`). Track machinery (`blueprint-track.ts`) makes a worktree at BUILD; merge is manual through `landingService.land()` (`track.ipc.ts:113`).
- External: aider auto-commits every edit with a weak-model message. Claude Code's own checkpointing does not see Bash-driven changes, so it is not a substitute. OpenHands does not auto-commit.
- Verdict: keep. Frame it as "enforce the protocol the prompt already states": on success, if the worktree is dirty, commit; if clean (agent already committed), skip. Never touch the primary tree when the track fell back to `primary` mode.

### A4 — repo-map injection
- Code: `repomap-mcp` is in `package.json` but unused in `src/`; the app deep-imports only `repomap-mcp/dist/tags.js` and `languages.js` from the indexing IPC. The graph is built by `code-graph.service.ts` and bootstrapped before wave 1 against the execution worktree via a shadow workspace (`:614–627`). Library surface does exist (`RepoMap` class in `dist/repomap.js` with `focusFiles`, `priorityFiles`, `priorityIdentifiers`, `mapTokens`), so the plan's open question 3 is answered, but it is undocumented and the package has one maintainer and no adoption.
- External: aider's repo map (tree-sitter defs/refs graph, PageRank, binary-search to a token budget) is the pattern, but aider publishes no benchmark uplift for it. Anthropic's Claude Code fan-out staggers same-prefix launches by up to 5 s so siblings hit the first agent's cache; worth copying in `executeDag` when launching a wave.
- Verdict: keep, but generate the map from `code-graph-edge.repository.ts` (already indexed, already scoped to the right tree). Use `repomap-mcp` only as reference code for the ranking + budgeting algorithm.

### B1 — session resume on retry (highest-value item)
- Code: `cli-executor.ts` already captures the id (`:816`) and passes `--resume` when `AgentSessionService` finds one in `sessionMap` by conversation id (`agent-session.service.ts:1728`). Spec, plan, tasks, review, verify and code-review phases all do `if (priorConvId && conversationRepository.getSessionId(priorConvId))` on retry. Build does not, because of the per-attempt `Date.now()` in the conversation id. The current "resume" is a regex lookup of a `build-partial` artifact stuffed into the prompt (`:2986–2993`, 4,000-char cap).
- Redesign: reuse one conversation id per (blueprint, task) across gate retries and overload retries; persist the CLI/OpenCode session id on the task row (migration); on retry send a short incremental message (verdict + gate-fix instructions) instead of the full task context. Keep the cold path when no id exists or the session is poisoned. Escalation to lead (`escalateToLead`) should stay cold or use `--fork-session`, since the lead model differs and a model switch invalidates the cache anyway.
- Constraints from the docs you must respect on every resume: re-pass `--mcp-config`, `--allowedTools`, `--permission-mode` (bypass is never restored; a resumed `-p` run starts in Manual), `--settings`, `--add-dir`. MCP servers restart per process; assert expected servers in `system/init.mcp_servers` (known issue: failed MCP on resume is silent, tools in history vanish). Never run two processes on one session id. Resuming after a CLI upgrade reprocesses history uncached. Anthropic's own SDK guidance is "don't rely on session resume across hosts; carry state as application state" — fine here because both attempts run on the same machine and worktree, but it argues for keeping the cold path healthy.
- OpenCode: `getOrCreateSession` (`:2500`) keys on the same conversation id, so the same fix removes the per-attempt `primeSession` cost too. Do not pass an OpenCode `ses_…` id to `claude --resume` (already bitten: commit `06f491f9`).
- Also available: `--fork-session` for lead escalation; `--json-schema` for structured output (see §4).
- Verdict: keep, make it Phase 1. Expected effect matches the plan's 50–80% retry-token claim only if retries are common; Phase 0 must measure retry rate first.

### B2 — task coalescing
- Code: `filesOverlap` (`:297`), `allInFlightFiles` (`:1047`), empty-file tasks are exclusive (`:1168–1173`). Verified. Legacy `executeWave` has its own copy (`:1544`).
- External: Anthropic's multi-agent post explicitly says multi-agent is wrong for "domains that require all agents to share the same context … most coding tasks"; Cognition's "Don't build multi-agents" says parallel agents make conflicting implicit decisions; MAST (1,600+ traces) puts most failures in inter-agent misalignment. All three support coalescing state-sharing tasks into one run.
- Verdict: keep. Partial-success handling is the hard part; the plan's split-completion approach is right. Decide the completion-block format before touching the parser.

### B3 — handoff packets
- Code: `capArtifactForContext` (`:194`), `ARTIFACT_MD_CAPS_BY_TIER` (`:178`), `PHASE_ARTIFACT_RELEVANCE` (`:72`) verified. Handoff message pattern verified (uncommitted change adds multi-ticket Jira listing).
- External: OpenHands' condenser (summarise the middle, keep goals / progress / remaining work / critical files / failing tests) is the closest measured precedent: 54% vs 53% SWE-bench Verified with per-turn cost under half. That is evidence that structured summaries do not hurt quality, not that they help it.
- Verdict: keep, after Phase 0 shows phase-context tokens are a real cost.

### C1 — AIMD
- Code: cap halves once on overload (`:1226–1233`), never rises. `recordParallelism` (`:1066`) is a histogram only.
- External: Netflix `AIMDLimit` and promptfoo both do −50% on 429 / +1 after sustained success. Anthropic rate limits punish sharp ramps ("ramp up gradually"). The CLI emits `system/api_retry` events with `error` category and `retry_delay_ms`; that is the right signal, cleaner than parsing error strings. On a Max subscription the binding limit is the 5-hour / weekly window; treat "usage limit reached" as a stop, not a backoff.
- Verdict: keep, small. Increase on N consecutive successes with no `api_retry` events in the wave.

### C2 — prefetch
- Verdict: defer until A2/A4 measurably slow dispatch.

### D1 — curator
- External: Anthropic recommends structured note-taking outside the window (NOTES.md pattern); the lead agent in their research system saves its plan to memory before truncation. Devin Knowledge publishes no outcome metrics. Curator cost cap (<5% of build tokens) is a good guard.
- Verdict: keep as the only D item worth doing soon; markdown artifact, cheap model, once per wave.

### D2 / D3 / D4
- D2 adds a pre-dispatch LLM call; Anthropic's guidance is to scale effort to complexity and use sub-agents for verbose self-contained search. Fine in principle, defer until deterministic wins are measured.
- D3: extend `saveRetryContext` recurrence detection first; quarantine dispatch is the riskiest idea in the plan.
- D4: the OpenCode counter (`CIRCUIT_BREAKER_THRESHOLD = 5`, `:404`) is not a provider breaker. A real breaker (closed / open / half-open, keyed by provider, fed by `api_retry` and transient-pattern hits) is worth building because it also fixes the "stall burns retries task by task" problem in §3. Failover between Claude and a local model is a different feature with a capability cliff; leave it out.

---

## 3. What is actually hurting (commit log, last ~40 commits)

1. Retry burn on non-converging or environmental failures: `f4ee2fc0`, `998ad13f`; incident note at `blueprint.service.ts:1801` ("attempt counter reached 10 with the identical gate failure every time").
2. Provider stalls misclassified: `60006c30` (no-activity timeout not retryable), `db328a1f`, `06f491f9` (5 SSE stalls, zero executor retries fired).
3. OpenCode worktree event-bus blindness: `2ab33c13`, `87e31855` (reintroduced in recovery path), `6a7f97bd`, `884d6df9`.
4. Recovery turns on silent tool completion: `0f811c73`, `06f491f9` part C, `bf221960`.
5. Parallel-task races on the singleton OpenCode server: `2d12310b`, `c56668e3`.
6. Scheduler / parser terminal races: `c396fbb4`, `7f792f68`, `2bbfe7fe`.

None of these is a token-economics problem. Four of six are "we lost track of a live session" problems, which is exactly what B1 (one durable conversation per task) and a real provider breaker (D4-lite) address. That argues for the reordering in §5.

---

## 4. Ideas from outside the plan worth adopting

1. **`--json-schema` structured output** is official in the CLI (`--output-format json --json-schema '<schema>'` → `structured_output`; retries on mismatch, `error_max_structured_output_retries` otherwise). Applies to the `-p` runner today. For the interactive build path, check whether the installed CLI honours it on `stream-json`; if it does, it replaces `parsePhaseCompletionBlock` regex parsing and the "empty-parse task sails into review" class of bugs (`7f792f68`).
2. **`system/api_retry` events** (category `rate_limit` / `overloaded`, `attempt`, `retry_delay_ms`) as the single overload signal for C1 and D4 instead of string matching.
3. **`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`** in the spawn env, and verify hits with `usage.cache_creation.ephemeral_1h_input_tokens` in the result event.
4. **Stagger same-prefix launches** by a few seconds at wave start so the first task writes the cache and siblings read it (Claude Code's own fan-out does ≤5 s).
5. **`system/init.mcp_servers` assertion** on every spawn and resume; today a failed MCP server is silent.
6. **`--fork-session`** for lead escalation and peer review: inherits the builder's context without sharing the transcript.
7. **File checkpointing in headless mode** (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` + `--rewind-files`) exists but does not track Bash edits; A3's git commit remains the right primitive.
8. **Policy watch:** Anthropic announced, then paused on 2026-06-15, moving `claude -p` / SDK usage off subscription limits onto a separate credit pool. Spawning the unmodified CLI with the user's own login is the permitted pattern; using the Agent SDK with OAuth is not. Keep the CLI-spawn design; do not migrate build to the SDK. `--bare` mode does not work with subscription login.
9. **No official number** for how cached reads count toward Max limits. Anthropic states cache hits "help create more generous rate limits" and API ITPM ignores cache reads. Treat cache-hit ratio as a proxy, not a guarantee.

---

## 5. Recommended phasing (revised)

**Phase 0 — Baseline, zero code.** Query `usage_log` where `feature='blueprint-build'` grouped by `conversation_id` prefix: tokens per task, cache-hit ratio `cache_read/(input+cache_read)`, attempts per task from `blueprint_tasks.attempts`, first-attempt vs retry gate pass from `gates_json`. Add stall / recovery incident counts from event logs. Record in the plan's appendix.

**Phase 1 — Durable task session (B1 for both paths) + A3 commit safety net.** One conversation id per (blueprint, task); persist session id on the task row; incremental retry message; poisoned-session and UUID guards kept; flags re-passed on resume; `mcp_servers` asserted. A3 rides along because it makes each attempt's diff inspectable. Gate: retry tokens down, retry pass rate flat, no increase in silent-completion recoveries.

**Phase 2 — Context economics (A2, A4 from code-graph, A1 tidy-up, launch stagger, 1h TTL).** Gate: tokens per task down, cache-hit ratio up.

**Phase 3 — Scheduler (C1 on `api_retry`, provider breaker, B2 coalescing, decide `executeWave` fate).** Gate: wave wall clock down, overload incidents flat.

**Phase 4 — B3 packets, D1 curator, then D2/D3 only if Phase 0–3 numbers say so.**

---

## 6. Open questions, revised

1. Does the installed CLI (2.1.257) honour `--json-schema` in interactive `stream-json` mode, or only with `-p`? Test before designing the coalesced completion format.
2. Does `--resume` preserve the session id on this CLI version (older issues #12235 / #10806 reported a new id after resume)? Verify empirically once.
3. Session transcript location depends on cwd; build runs in a worktree. Confirm resume works with the worktree path across attempts (docs say v2.1.223+ searches worktrees too).
4. For OpenCode, confirm `getOrCreateSession` reuse across attempts does not collide with the refcounted server lifecycle fix in `2d12310b`.

---

## Sources

- CLI reference: https://code.claude.com/docs/en/cli-reference
- Headless / `-p`: https://code.claude.com/docs/en/headless
- Sessions and resume semantics: https://code.claude.com/docs/en/sessions
- Prompt caching in Claude Code: https://code.claude.com/docs/en/prompt-caching
- API prompt caching (ordering, minimums, TTL): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Cost tracking / result shape: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Checkpointing: https://code.claude.com/docs/en/checkpointing , https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- Fan-out cache stagger: https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out
- Sub-agents guidance: https://code.claude.com/docs/en/sub-agents
- Legal / credential use: https://code.claude.com/docs/en/legal-and-compliance
- Subscription + headless policy pause: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Rate limits: https://platform.claude.com/docs/en/api/rate-limits
- Anthropic, context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic, prompt caching is everything: https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
- Cognition, Don't build multi-agents: https://cognition.com/blog/dont-build-multi-agents
- MAST failure taxonomy: https://arxiv.org/abs/2503.13657
- Aider repo map: https://aider.chat/docs/repomap.html , https://aider.chat/2023/10/22/repomap.html
- Aider git: https://aider.chat/docs/git.html
- OpenHands condenser: https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents , https://arxiv.org/abs/2511.03690
- Devin Knowledge: https://docs.devin.ai/product-guides/knowledge
- Netflix concurrency-limits (AIMD): https://github.com/Netflix/concurrency-limits
- promptfoo rate limiting (AIMD for LLMs): https://www.promptfoo.dev/docs/configuration/rate-limits/
- repomap-mcp: https://github.com/fl0w1nd/repomap-mcp
- Known issues: https://github.com/anthropics/claude-code/issues/5524 , /issues/43968 , /issues/12235

---

## 7. Second-pass sources (platform survey and retry research, 2026-09-01)

Orchestration / spec-driven: Kiro specs https://kiro.dev/docs/specs/ , waves https://kiro.dev/changelog/ide/0-12/ , "Run all tasks" rationale https://kiro.dev/blog/run-all-tasks/ , sub-agent failure https://github.com/kirodotdev/Kiro/issues/8402 , Kiro Crew breaker https://raw.githubusercontent.com/kirodotdev/KiroCrew/main/docs/architecture/overview.md ; OpenAI Symphony spec https://raw.githubusercontent.com/openai/symphony/main/SPEC.md , Codex non-interactive https://learn.chatgpt.com/docs/non-interactive-mode.md , Codex V2 override removal https://github.com/openai/codex/issues/32031 ; Cursor scaling agents https://cursor.com/blog/scaling-agents , dynamic context discovery https://cursor.com/blog/dynamic-context-discovery , worktrees https://cursor.com/docs/configuration/worktrees ; Claude Code workflows https://code.claude.com/docs/en/workflows , agent teams https://code.claude.com/docs/en/agent-teams , sub-agents https://code.claude.com/docs/en/sub-agents , long-running harness https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents , harness design https://www.anthropic.com/engineering/harness-design-long-running-apps , C compiler https://www.anthropic.com/engineering/building-c-compiler ; Roo orchestrator https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks ; Cline subagents https://github.com/cline/cline/blob/main/docs/features/subagents.mdx ; Kilo orchestrator deprecation https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode ; Vibe Kanban shutdown https://www.vibekanban.com/blog/shutdown ; Devin multi-agents https://cognition.com/blog/multi-agents-working , Fusion https://cognition.com/blog/devin-fusion , manage Devins https://cognition.com/blog/devin-can-now-manage-devins ; Factory missions https://factory.ai/news/missions , compression https://factory.ai/news/compressing-context ; Jules critic https://developers.googleblog.com/meet-jules-sharpest-critic-and-most-valuable-ally/ ; Plandex roles https://raw.githubusercontent.com/plandex-ai/plandex/main/docs/docs/models/roles.md ; Augment Intent https://www.augmentcode.com/guides/intent-walkthrough-prompt-to-merge , harness rebuild https://www.augmentcode.com/blog/auggie-cli-harness-rebuild-53-percent-cheaper ; Gemini investigator https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/agents/codebase-investigator.ts , loop detection https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/loopDetectionService.ts ; Copilot cloud agent https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent ; Amp handoff/Neo https://ampcode.com/news/handoff , https://ampcode.com/news/neo .

SWE-bench lineage: OpenHands SDK paper https://arxiv.org/html/2511.03690v2 , stuck detector https://docs.openhands.dev/sdk/guides/agent-stuck-detector.md , critic https://docs.openhands.dev/sdk/guides/critic.md ; SWE-agent ACI https://arxiv.org/html/2405.15793 , mini-swe-agent https://raw.githubusercontent.com/SWE-agent/mini-swe-agent/main/README.md ; Agentless https://arxiv.org/html/2407.01489 , Agentless Mini https://arxiv.org/pdf/2502.18449 ; Aider architect https://aider.chat/2024/09/26/architect.html , repomap.py https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py ; Goose lead/worker removal https://github.com/aaif-goose/goose/pull/7989 , tool-pair summarisation https://github.com/aaif-goose/goose/issues/11764 , subagent lessons https://raw.githubusercontent.com/aaif-goose/goose/main/documentation/blog/2025-07-21-orchestrating-subagents/index.md ; Refact fork task cards https://github.com/JegernOUTT/refact/wiki/Task-Planner-and-Cards .

Academic: MetaGPT https://arxiv.org/pdf/2308.00352 ; ChatDev https://arxiv.org/pdf/2307.07924 ; AgentCoder https://arxiv.org/pdf/2312.13010 ; self-correction limits https://arxiv.org/abs/2310.01798 ; MAST https://arxiv.org/html/2503.13657 ; CodeMonkeys https://arxiv.org/abs/2501.14723 ; Trae https://arxiv.org/abs/2507.23370 ; RTV/PDR https://arxiv.org/abs/2604.16529 ; CAID https://arxiv.org/abs/2603.21489 ; "Why Retrying Fails" https://arxiv.org/html/2605.08563 ; AgentRewind https://arxiv.org/html/2608.14380v1 ; TRACE https://arxiv.org/html/2608.06503 ; "Less Context, Better Agents" https://arxiv.org/html/2606.10209v1 ; Slipstream https://arxiv.org/html/2605.08580 ; context rot https://www.trychroma.com/research/context-rot ; SWE-bench Pro https://arxiv.org/html/2509.16941v2 .

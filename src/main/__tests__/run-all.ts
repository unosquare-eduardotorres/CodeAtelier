/**
 * Unified test entrypoint for coverage runs.
 *
 * Loads every registered test file (services + repositories + IPC) and
 * calls `summaryAsync()` exactly once so a single `c8 tsx ...` invocation
 * produces one merged coverage report.
 *
 * Uses dynamic imports in a sequential loop so that:
 *   1. Any file that fails to load reports loudly (no silent truncation)
 *   2. A completeness sentinel prints after all files are loaded
 *   3. Individual file failures don't block the rest of the suite
 *
 * NOTE: This file deliberately loads each test file individually rather than
 * importing the existing `services/__tests__/run-tests.ts` and
 * `db/repositories/__tests__/run-tests.ts` entrypoints. Each of those calls
 * `process.exit()` (synchronously, in the repo runner) which would cancel
 * still-pending async tests and prevent a unified run. The standalone
 * entrypoints remain unchanged so `npm run test:unit` / `npm run test:repo`
 * keep working.
 *
 * Usage: invoked by the `test:cov`, `test:cov:html`, and `test:cov:check`
 * scripts in package.json.
 */
import { setupElectronStub } from '../services/__tests__/electron-stub'
import { summaryAsync } from '../services/__tests__/test-harness'

// Install the shared electron/electron-log stubs ONCE before any test file
// loads. See run-tests.ts for rationale.
setupElectronStub()

// ─────────────────────────────────────────────────────────────────────────────
// Service tests (mirrors src/main/services/__tests__/run-tests.ts)
// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_TEST_FILES: string[] = [
  '../services/__tests__/generalist-migration.test',
  '../services/__tests__/event-sequence.test',
  '../services/__tests__/agent-services.test',
  '../services/__tests__/mcp-server-service.test',
  '../services/__tests__/preprocessing.test',
  '../services/__tests__/description-cache.test',
  '../services/__tests__/code-graph-logic.test',
  '../services/__tests__/vector-search.test',
  '../services/__tests__/code-graph-db.test',
  '../services/__tests__/mcp-tool-wiring.test',
  '../services/__tests__/path-traversal.test',
  '../services/__tests__/control-actions.test',
  '../services/__tests__/conversation-state-machine.test',
  '../services/__tests__/intent-detector.test',
  '../services/__tests__/intent-router.test',
  // Run 3 — P0 continued
  '../services/__tests__/agent-circuit-breaker.test',
  // Run 4 — P1 targets
  '../services/__tests__/cost-tracker.test',
  '../services/__tests__/agent-token-tracker.test',
  '../services/__tests__/elicitation.test',
  // Run 5 — P1 expansion
  '../services/__tests__/model-config.test',
  '../services/__tests__/opus-48-thinking.test',
  '../services/__tests__/session-recovery.test',
  // Run 6 — lifecycle
  '../services/__tests__/conversation-lifecycle.test',
  // Run 6b — Project Specialist refactor (Phase 1)
  '../services/__tests__/agent-session.service.test',
  // Run 6c — Project Specialist refactor (Phase 2)
  '../services/__tests__/prompt-assembly-helpers.test',
  '../services/__tests__/project-specialist-prompt-template.test',
  '../services/__tests__/project-specialist-adapter.test',
  '../services/__tests__/stack-drift-detector.test',
  '../services/__tests__/tech-stack-detector.test',
  '../services/__tests__/specialist-builder-meta-prompt.test',
  // Run 6d — Phase 4 cleanup
  '../services/__tests__/layer2-rename-migration.test',
  // Run 7 — IPC protocol + input validation
  '../ipc/__tests__/chat-protocol.test',
  '../ipc/__tests__/validate-args.test',
  // Run 8 — bubble identity / role tagging / consent regression
  '../services/__tests__/chat-stream-role-tagging.test',
  // Run 9 — renderer utilities (pure logic, no DOM)
  '../services/__tests__/sentence-buffer.test',
  '../services/__tests__/parse-blocked-by-error.test',
  // ─── Run 11: Prompt optimization (Opus 4.8) ───
  '../services/__tests__/prompt-verbosity.test',
  '../services/__tests__/prompt-lean-identity.test',
  '../services/__tests__/prompt-lean-mode.test',
  // ─── Run 12: MPA (Multi-Phased Agent Pipeline) ───
  '../services/__tests__/mpa-goal-conditions.test',
  '../services/__tests__/mpa-preflight.test',
  '../services/__tests__/mpa-orchestration.test',
  '../services/__tests__/goal-decomposer.test',
  '../services/__tests__/mpa-verify-criteria.test',
  '../services/__tests__/multi-session.test',
  // ─── Run 13: Council (LLM Council) ───
  '../services/__tests__/council.service.test',
  // ─── Run 14: Grill Plan + Resume ───
  '../services/__tests__/grill-plan-and-resume.test',
  '../services/__tests__/grill-plan-from-decisions.test',
  '../services/__tests__/grill-handoff-utils.test',
  // ─── Run 15: Tool Chunk Processor (centralized pipeline) ───
  '../ipc/__tests__/tool-chunk-processor.test',
  // ─── Run 16: Context usage level/quality resolution ───
  '../services/__tests__/context-usage-level.test',
  // ─── Run 17: Context compaction verification (badge + thresholds + local) ───
  '../services/__tests__/compaction-thresholds.test',
  '../services/__tests__/local-compaction.test',
  '../services/__tests__/auto-compact-options.test',
  // ─── Run 18: oMLX embedding provider ───
  '../services/__tests__/omlx-embedding.test',
  // ─── Run 19: Previously-orphaned test files (registered for coverage) ───
  '../services/__tests__/context-management.test',
  '../services/__tests__/workspace-mcp-config-tiers.test',
  '../services/__tests__/tag-to-chunk-adapter.test',
  '../services/__tests__/skill-summary.test',
  '../services/__tests__/agent-session-token-split.test',
  // ─── Run 20: Coverage expansion — streaming / tools / hooks (pure logic) ───
  '../services/__tests__/thinking-parser.test',
  '../ipc/__tests__/tool-result-summarizer.test',
  '../services/__tests__/tool-input-summarizer.test',
  '../services/__tests__/tool-activity-accumulator.test',
  '../services/__tests__/opencode-event-normalizer.test',
  '../services/__tests__/hook-engine.test',
  // ─── Run 21: Coverage expansion — chat / handlers / MCP ───
  '../services/__tests__/sanitize-prompt-input.test',
  '../services/__tests__/mode-permissions.test',
  '../services/__tests__/system-prompt-cache.test',
  '../services/__tests__/context-budget-auditor.test',
  '../services/__tests__/structured-output-repair.test',
  '../services/__tests__/session-event-router.test',
  '../services/__tests__/agent-stream-processor.test',
  '../services/__tests__/chat-agent.service.test',
  // ─── Run 22: Coverage expansion — health / grilling / embeddings ───
  '../services/__tests__/indexing-diagnostics.test',
  '../services/__tests__/quality-gate-runner.test',
  '../services/__tests__/council-parser.test',
  '../services/__tests__/mpa-artifact-parsers.test',
  '../services/__tests__/mpa-campaign-retry.test',
  '../services/__tests__/ollama-manager.test',
  '../services/__tests__/omlx-manager.test',
  '../services/__tests__/grill-parsers.test',
  // ─── Run 23: Coverage expansion — parser / dispatch / resolver family ───
  '../services/__tests__/audit-response-parser.test',
  '../ipc/__tests__/text-delta-batcher.test',
  '../services/__tests__/prompt-variant.test',
  '../services/__tests__/env-utils.test',
  '../services/__tests__/context-window-resolver.test',
  '../services/__tests__/agent-recovery-nudge.test',
  '../ipc/__tests__/chunk-router.test',
  '../services/__tests__/grill-plan-mapper.test',
  // ─── Run 24: stdin-safe one-shot Claude CLI runner ───
  '../services/__tests__/claude-cli-oneshot.test',
  // ─── Run 25: Unified token usage logging (usage_log sink) ───
  '../services/__tests__/usage-tracker.service.test',
  '../services/__tests__/one-shot-claude.test',
  // ─── Run 26: Plan-mode UX — ask_user registry (no-timeout) + before-plan guard ───
  '../mcp-servers/__tests__/ask-user-registry.test',
  '../services/__tests__/ask-user-guard.test',
  // ─── Run 27: Executor family + audit/parsing pipeline ───
  '../services/__tests__/tool-tracker.test',
  '../services/__tests__/token-accountant.test',
  '../services/__tests__/heartbeat-monitor.test',
  '../services/__tests__/stream-normalizer.test',
  '../services/__tests__/ndjson-parser.test',
  '../services/__tests__/output-cap.test',
  '../services/__tests__/audit-coverage-tracker.test',
  '../services/__tests__/audit-prompt-templates.test',
  '../services/__tests__/claude-md-generator.test',
  '../services/__tests__/workspace-deploy-parsing.test',
  // ─── Run 28: ChatStreamService decomposition (lifecycle method extraction) ───
  '../services/__tests__/chat-stream-lifecycle.test',
  // ─── Run 29: Prompt/Skill assembly + executor telemetry + listener cleanup + sandbox ───
  '../services/__tests__/telemetry-recorder.test',
  '../ipc/__tests__/listener-cleanup.test',
  '../services/__tests__/prompt-builder.test',
  '../services/__tests__/skill-prompt-composer.test',
  '../services/__tests__/sandbox-config.test',
  // ─── Run 30: Blueprint pipeline — parsers, conditions, review service, build service ───
  '../services/__tests__/blueprint-parsers-conditions.test',
  '../services/__tests__/blueprint-review.service.test',
  '../services/__tests__/blueprint-build.service.test',
  '../services/__tests__/blueprint-send-outcome.test',
  '../services/__tests__/blueprint-verify-conditions.test',
  // ─── Run 31: Plan Hub — unified plan registry ───
  '../services/__tests__/audit-plan-mapper.test',
  '../services/__tests__/plan-registry.test',
  // ─── Run 32: Library Documentation Service (three-tier lookup) ───
  '../services/__tests__/library-doc-service.test',
  // ─── Run 33: ESLint MCP tools ───
  '../services/__tests__/eslint-mcp-tools.test',
  '../services/__tests__/analyze-complexity.test',
  // ─── Run 34: Adapter family + session accessors + blueprint/eval pure functions ───
  '../services/__tests__/evaluation-mcp-config.test',
  '../services/__tests__/mpa-base-adapter.test',
  '../services/__tests__/grill-adapter.test',
  '../services/__tests__/greenfield-grill-adapter.test',
  '../services/__tests__/blueprint-service-logic.test',
  '../services/__tests__/cli-mcp-config-writer-logic.test',
  // ─── Run 35: Adapter subclass family + pure functions + config builders ───
  '../services/__tests__/mpa-planner-adapter.test',
  '../services/__tests__/mpa-verifier-adapter.test',
  '../services/__tests__/mpa-builder-adapter.test',
  '../services/__tests__/blueprint-base-adapter.test',
  '../services/__tests__/blueprint-build-adapter.test',
  '../services/__tests__/blueprint-verify-adapter.test',
  '../services/__tests__/repo-service-pure.test',
  '../services/__tests__/opencode-config-writer-logic.test',
  '../services/__tests__/opencode-config-schema.test',
  '../services/__tests__/opencode-cli-check.test',
  '../services/__tests__/opencode-path-augmentation.test',
  '../services/__tests__/description-cache-pure.test',
  '../services/__tests__/workspace-mcp-config-logic.test',
  // ─── Run 35b: Phase 13 coverage mega-push — adapters, pure functions, repositories ───
  '../services/__tests__/blueprint-remaining-adapters.test',
  '../services/__tests__/council-member-adapter.test',
  '../services/__tests__/council-chairman-adapter.test',
  '../services/__tests__/audit-adapter.test',
  '../services/__tests__/skill-tiers-parser.test',
  '../services/__tests__/parse-plan-payload.test',
  '../services/__tests__/specialist-builder-pure.test',
  '../services/__tests__/blueprint-prompt-loader-pure.test',
  '../services/__tests__/repository-maprow-logic.test',
  '../services/__tests__/base-adapter-strategies.test',
  '../services/__tests__/heuristic-description-logic.test',
  '../services/__tests__/event-logger-service.test',
  '../mcp-servers/__tests__/mcp-server-registration.test',
  // ─── Run 36: Phase 14 coverage mega-push — IPC registration, executors, service methods ───
  '../services/__tests__/cli-executor-args.test',
  '../services/__tests__/opencode-executor-pure.test',
  '../services/__tests__/agent-session-deep.test',
  '../services/__tests__/chat-stream-methods.test',
  '../services/__tests__/mpa-orchestration-helpers.test',
  '../services/__tests__/council-service-helpers.test',
  '../services/__tests__/grill-agent-helpers.test',
  '../services/__tests__/audit-agent-helpers.test',
  '../services/__tests__/grill-persistence-logic.test',
  '../services/__tests__/council-persistence-logic.test',
  '../services/__tests__/shared-types-coverage.test',
  '../services/__tests__/blueprint-spec-helpers.test',
  '../services/__tests__/plan-registry-helpers.test',
  '../services/__tests__/zero-coverage-services.test',
  // ─── Phase 15: Coverage Mega-Push — pure function tests ───
  '../services/__tests__/default-prompts-constants.test',
  '../services/__tests__/preprocessing-pure.test',
  '../services/__tests__/vector-search-pure.test',
  // ─── Phase 16: Coverage Mega-Push II — types, services, IPC, MCP ───
  '../services/__tests__/type-coverage.test',
  '../services/__tests__/mpa-orchestration-deep.test',
  '../services/__tests__/service-mid-coverage-deep.test',
  '../ipc/__tests__/ipc-zero-coverage.test',
  '../ipc/__tests__/ipc-blueprint-handlers.test',
  '../ipc/__tests__/ipc-audit-handlers.test',
  '../ipc/__tests__/ipc-crud-deep.test',
  '../mcp-servers/__tests__/mcp-server-tools-deep.test',
  '../mcp-servers/__tests__/mcp-tool-bodies.test',
  // ─── OpenCode error pipeline (normalizer → processor end-to-end) ───
  '../services/__tests__/opencode-error-pipeline.test',
  // ─── Phase 17: Coverage Mega-Push III — IPC handler bodies, service instances, adapters ───
  '../ipc/__tests__/ipc-handler-bodies.test',
  '../services/__tests__/service-instance-deep.test',
  '../services/__tests__/blueprint-pipeline-instance.test',
  '../services/__tests__/adapter-branch-push.test',
  '../services/__tests__/migration-metadata.test',
  // ─── Blueprint retry + CLI error-path tests ───
  '../services/__tests__/blueprint-retry.test',
  // ─── Goal command builder + goalMode gating + drain logic ───
  '../services/__tests__/cli-executor-goal.test',
  // ─── Blueprint store guard (workspace event adoption logic) ───
  '../services/__tests__/blueprint-store-guard.test',
  // ─── Blueprint pipeline hardening — state machine + phase chain + clarify + chunk forwarder ───
  '../services/__tests__/blueprint-phase-chain.test',
  '../services/__tests__/blueprint-clarify-parsers.test',
  '../services/__tests__/blueprint-clarify-gate.test',
  '../services/__tests__/blueprint-state-machine.test',
  '../services/__tests__/blueprint-recovery-gating.test',
  '../services/__tests__/blueprint-chunk-forwarder.test',
  // ─── Blueprint Crash Recovery, Discoveries, Resolve Assignment ───
  '../services/__tests__/blueprint-resume.test',
  '../services/__tests__/blueprint-discoveries.test',
  '../services/__tests__/resolve-assignment.test',
  '../services/__tests__/snapshot-resolver.test',
  // ─── Prompt Optimizer ───
  '../services/__tests__/prompt-optimizer.test',
  // ─── Pipeline Stabilization Round 2 — phase watchdog + registry sync guard ───
  '../services/__tests__/blueprint-phase-watchdog.test',
  '../services/__tests__/cli-executor-kill.test',
  // ─── Memory Engine (knowledge-aware) ───
  '../services/__tests__/memory-engine.test',
  '../services/__tests__/memory-retrieval.test',
  '../services/__tests__/memory-extraction.test',
  '../services/__tests__/memory-doc-watcher.test',
  // ─── Memory Consolidation (cluster merge, idle job) ───
  '../services/__tests__/memory-consolidation.test',
  '../services/__tests__/memory-consolidation-archival.test',
  // ─── Memory Graph (knowledge graph edge derivation) ───
  '../services/__tests__/memory-graph.test',
  // ─── E2E Testing Infrastructure ───
  '../services/__tests__/e2e-contracts.test',
  // ─── Blueprint document loader ───
  '../services/__tests__/blueprint-document-loader.test',
  // ─── Blueprint durability (journal mapper, viewState precedence) ───
  '../services/__tests__/blueprint-durability.test',
  // ─── Blueprint agent accumulator (flush boundaries, caps, cancel, taskId) ───
  '../services/__tests__/blueprint-agent-accumulator.test',
  // ─── Phase 18: Coverage Mega-Push IV — giant services deep + MCP tool bodies ───
  '../services/__tests__/giant-services-deep.test',
  '../services/__tests__/adapter-completion-round2.test',
  '../services/__tests__/coverage-mega-push-phase18.test',
  '../services/__tests__/coverage-push-phase18b.test',
  // ─── Blueprint clarify ask_user bridge ───
  '../services/__tests__/blueprint-clarify-askuser.test',
  // ─── Memory Capture Expansion (blueprint/grill/document hooks) ───
  '../services/__tests__/memory-extraction-content.test',
  '../services/__tests__/blueprint-memory-hooks.test',
  '../services/__tests__/grill-memory-sync.test',
  // ─── Blueprint MCP tool availability fix ───
  '../services/__tests__/mcp-skip-servers.test',
  // ─── Document Ingestion (reader, chunker, orchestration service) ───
  '../services/__tests__/document-chunker.test',
  '../services/__tests__/document-reader.test',
  '../services/__tests__/memory-ingestion.test',
  '../services/__tests__/memory-bootstrap.test',
  // ─── Local-LLM hermeticity fixes (FK guard + recovery gating) ───
  '../services/__tests__/local-plan-state-fk-guard.test',
  // ─── Phase 19 deep coverage ───
  '../services/__tests__/session-stream-deep-phase19.test',
  '../services/__tests__/executor-deep-phase19.test',
  '../services/__tests__/blueprint-services-deep.test',
  '../services/__tests__/orchestrator-pipeline-deep.test',
  '../services/__tests__/memory-vector-deep.test',
  '../services/__tests__/mcp-servers-deep.test',
  // ─── Phase 20A: Coverage Mega-Push VI — giant services deep ───
  '../services/__tests__/agent-session-body-deep.test',
  '../services/__tests__/chat-stream-body-deep.test',
  '../services/__tests__/code-analysis-handlers.test',
  '../services/__tests__/blueprint-spec-deep.test',
  '../services/__tests__/blueprint-parallel-scheduler.test',
  '../services/__tests__/blueprint-verify-extractor.test',
  // ─── Phase 21: Coverage Mega-Push ───
  '../services/__tests__/memory-engine-extraction-deep.test',
  '../services/__tests__/blueprint-services-deep-phase21.test',
  '../services/__tests__/council-mpa-grill-services-deep.test',
  '../services/__tests__/quick-win-coverage-boost.test',
  '../services/__tests__/ipc-conversation-handlers.test',
  '../services/__tests__/ipc-workspace-agent-handlers.test',
  '../services/__tests__/ipc-grill-audit-council-handlers.test',
  '../services/__tests__/ipc-remaining-handlers.test',
  // ─── Blueprint Environment Preflight ───
  '../services/__tests__/blueprint-preflight.test',
  // ─── Verify phase dual-field remediation read (phase-summaries parity) ───
  '../services/__tests__/phase-summaries-verify.test',
  // ─── Permission Prompt Flow (registry, stream-normalizer, tool-chunk-processor) ───
  '../services/__tests__/permission-prompt-flow.test',
  // ─── Background CLI Session (persistent warm process for prompt optimizer) ───
  '../services/__tests__/background-cli-session.test',
  // ─── PR Description Generation (CHAT_GENERATE_PR_DESCRIPTION handler logic) ───
  '../services/__tests__/pr-description-generation.test',
  // ─── Executor derivation (Phase A: provider → backend mapping) ───
  '../services/__tests__/executor-derivation.test',
  // ─── Local embedding provider facade (oMLX/Ollama routing) ───
  '../services/__tests__/local-embedding-provider.test',
  // ─── Phase 22: Coverage Mega-Push — pure functions, IPC validation, MCP helpers ───
  '../services/__tests__/validate-args-pure.test',
  '../services/__tests__/stream-helper-deep.test',
  '../services/__tests__/audit-handoff-service.test',
  '../services/__tests__/context-handoff-agent-sync.test',
  '../services/__tests__/chunk-router-metrics-deep.test',
  '../services/__tests__/preprocessing-repo-mappers.test',
  '../services/__tests__/chat-agent-executor-deep.test',
  '../services/__tests__/memory-ipc-workspace-ipc-deep.test',
  '../services/__tests__/mcp-servers-pure.test',
  // ─── Task execution tracking (task-level visibility in chat panel) ───
  '../services/__tests__/task-execution-tracking.test',
  // ─── Windows stability: isExcludedPath path-separator handling ───
  '../services/__tests__/is-excluded-path.test',
  // ─── Phase 24: IPC Coverage Blitz — 20 new IPC test files ───
  '../ipc/__tests__/ipc-bug-idea-events.test',
  '../ipc/__tests__/ipc-specialist-skill.test',
  '../ipc/__tests__/ipc-code-graph-indexing.test',
  '../ipc/__tests__/ipc-ollama-embedding.test',
  '../ipc/__tests__/ipc-docs-repo-github.test',
  '../ipc/__tests__/ipc-cost-token-log.test',
  '../ipc/__tests__/ipc-app-preference-zoom.test',
  '../ipc/__tests__/ipc-shell-sync-hooks.test',
  '../ipc/__tests__/ipc-core-agent-alias-prompt.test',
  '../ipc/__tests__/ipc-chat-lifecycle-shared.test',
  '../ipc/__tests__/ipc-checkpoint-permission.test',
  '../ipc/__tests__/ipc-workspace-project-session.test',
  '../ipc/__tests__/ipc-chat-completion-mode.test',
  '../ipc/__tests__/ipc-plan-sdk-handoff.test',
  '../ipc/__tests__/ipc-workspace-deploy-testing.test',
  '../ipc/__tests__/ipc-memory-deep.test',
  '../ipc/__tests__/ipc-blueprint-deep.test',
  '../ipc/__tests__/ipc-audit-deep.test',
  '../ipc/__tests__/ipc-grill-mpa-council-deep.test',
  '../ipc/__tests__/ipc-conversation-crud-deep.test',
  // ─── Phase 24: MCP Server Coverage ───
  '../mcp-servers/__tests__/code-graph-server.test',
  '../mcp-servers/__tests__/git-context-server.test',
  '../mcp-servers/__tests__/control-actions-server.test',
  // ─── Phase 24: Zero-Coverage Services ───
  '../services/__tests__/subscription-auto-update.test',
  '../services/__tests__/docs-mermaid-filewatcher.test',
  // ─── Phase 24: Deep Tests for Low/Medium-Coverage Services ───
  '../services/__tests__/low-coverage-services-deep-phase24.test',
  '../services/__tests__/medium-coverage-augment-phase24.test',
]

// ─────────────────────────────────────────────────────────────────────────────
// Repository tests (mirrors src/main/db/repositories/__tests__/run-tests.ts)
// ─────────────────────────────────────────────────────────────────────────────
const REPO_TEST_FILES: string[] = [
  '../db/repositories/__tests__/message.repository.test',
  '../db/repositories/__tests__/conversation.repository.test',
  '../db/repositories/__tests__/workspace.repository.test',
  '../db/repositories/__tests__/usage-log.repository.test',
  '../db/repositories/__tests__/grill-session.repository.test',
  '../db/repositories/__tests__/mpa-campaign.repository.test',
  '../db/repositories/__tests__/migration-v102.test',
  // ─── Phase 15: Coverage Mega-Push — repository tests ───
  '../db/repositories/__tests__/specialist.repository.test',
  '../db/repositories/__tests__/skill.repository.test',
  '../db/repositories/__tests__/bug.repository.test',
  '../db/repositories/__tests__/idea.repository.test',
  '../db/repositories/__tests__/event.repository.test',
  '../db/repositories/__tests__/blueprint.repository.test',
  '../db/repositories/__tests__/audit.repository.test',
  '../db/repositories/__tests__/mpa-run.repository.test',
  '../db/repositories/__tests__/council-session.repository.test',
  '../db/repositories/__tests__/plan.repository.test',
  '../db/repositories/__tests__/plan-status-history.test',
  '../db/repositories/__tests__/remaining-repos.test',
  '../db/repositories/__tests__/code-graph-repos.test',
  '../db/repositories/__tests__/migration-suite.test',
  // ─── Phase 16: Track 1 + Track 6 ───
  '../db/repositories/__tests__/migration-replay.test',
  '../db/repositories/__tests__/repo-branch-coverage.test',
  // ─── Phase 17: Coverage Mega-Push III ───
  '../db/repositories/__tests__/repo-deep-branch.test',
  // ─── E2E Testing Repos ───
  '../db/repositories/__tests__/e2e-test-repos.test',
  // ─── Windows stability: upsertEdgesBatched batching + edge cases ───
  '../db/repositories/__tests__/upsert-edges-batched.test',
  // ─── Phase 24: Zero-coverage repository tests ───
  '../db/repositories/__tests__/zero-coverage-repos-phase24.test',
]

// ─── Dynamic import loop with per-file error isolation ───
// Wrapped in async IIFE because the project is CJS (no top-level await).
const ALL_TEST_FILES = [...SERVICE_TEST_FILES, ...REPO_TEST_FILES]

void (async () => {
  let loadFailures = 0

  for (const file of ALL_TEST_FILES) {
    try {
      await import(file)
    } catch (err) {
      console.error(`\n[run-all] FAILED to load ${file}:`, err)
      loadFailures++
    }
  }

  if (loadFailures > 0) {
    console.error(`\n[run-all] ${loadFailures} file(s) failed to load`)
    process.exitCode = 1
  }
  console.log(`[run-all] all ${ALL_TEST_FILES.length} test modules loaded (${loadFailures} load failure(s))`)

  // Single summary at the end — awaits all pending async tests, prints totals,
  // and exits with code 1 on any failure.
  await summaryAsync()
})()

// Migration test runner entrypoint (used by: npx tsx src/main/services/__tests__/run-tests.ts)
//
// Uses dynamic imports in a sequential loop so that:
//   1. Any file that fails to load reports loudly (no silent truncation)
//   2. A completeness sentinel prints after all files are loaded
//   3. Individual file failures don't block the rest of the suite
import { setupElectronStub } from './electron-stub'
import { summaryAsync } from './test-harness'

// Install the shared electron/electron-log stubs ONCE before any test file
// loads. This guarantees every module in the CJS cache gets the full mock
// (ipcMain, app, BrowserWindow, …) instead of an undefined string.
// Individual test files that also call setupElectronStub() are safe — it's
// idempotent (guarded by `stubInstalled`).
setupElectronStub()

const TEST_FILES: string[] = [
  './generalist-migration.test',
  './event-sequence.test',
  './agent-services.test',
  './mcp-server-service.test',
  './preprocessing.test',
  './description-cache.test',
  './code-graph-logic.test',
  './vector-search.test',
  './code-graph-db.test',
  './mcp-tool-wiring.test',
  './path-traversal.test',
  './control-actions.test',
  './conversation-state-machine.test',
  './intent-detector.test',
  './intent-router.test',
  // Run 3 — P0 continued
  './agent-circuit-breaker.test',
  // Run 4 — P1 targets
  './cost-tracker.test',
  './agent-token-tracker.test',
  './elicitation.test',
  // Run 5 — P1 expansion
  './model-config.test',
  './opus-48-thinking.test',
  './session-recovery.test',
  // Run 6 — lifecycle
  './conversation-lifecycle.test',
  // Run 6b — Project Specialist refactor (Phase 1)
  './agent-session.service.test',
  // Run 6c — Project Specialist refactor (Phase 2)
  './prompt-assembly-helpers.test',
  './project-specialist-prompt-template.test',
  './project-specialist-adapter.test',
  './stack-drift-detector.test',
  './tech-stack-detector.test',
  './specialist-builder-meta-prompt.test',
  // Run 6d — Phase 4 cleanup
  './layer2-rename-migration.test',
  // Run 7 — IPC protocol + input validation (in ../../ipc/__tests__/)
  '../../ipc/__tests__/chat-protocol.test',
  '../../ipc/__tests__/validate-args.test',
  // Run 8 — bubble identity / role tagging / consent regression
  './chat-stream-role-tagging.test',
  // Run 9 — renderer utilities (pure logic, no DOM)
  './sentence-buffer.test',
  './parse-blocked-by-error.test',
  // ─── Run 11: Prompt optimization (Opus 4.8) ───
  './prompt-verbosity.test',
  './prompt-lean-identity.test',
  './prompt-lean-mode.test',
  // ─── Run 12: MPA (Multi-Phased Agent Pipeline) ───
  './mpa-goal-conditions.test',
  './mpa-preflight.test',
  './mpa-orchestration.test',
  './goal-decomposer.test',
  './mpa-verify-criteria.test',
  './multi-session.test',
  // ─── Run 13: Council (LLM Council) ───
  './council.service.test',
  // ─── Run 14: Grill Plan + Resume ───
  './grill-plan-and-resume.test',
  './grill-plan-from-decisions.test',
  './grill-handoff-utils.test',
  // ─── Run 15: Tool Chunk Processor (centralized pipeline) ───
  '../../ipc/__tests__/tool-chunk-processor.test',
  // ─── Run 16: Context usage level/quality resolution ───
  './context-usage-level.test',
  // ─── Run 17: Context compaction verification (badge + thresholds + local) ───
  './compaction-thresholds.test',
  './local-compaction.test',
  './auto-compact-options.test',
  // ─── Run 18: oMLX embedding provider ───
  './omlx-embedding.test',
  // ─── Run 19: Previously-orphaned test files (registered for coverage) ───
  './context-management.test',
  './workspace-mcp-config-tiers.test',
  './tag-to-chunk-adapter.test',
  './skill-summary.test',
  './agent-session-token-split.test',
  // ─── Run 20: Coverage expansion — streaming / tools / hooks (pure logic) ───
  './thinking-parser.test',
  '../../ipc/__tests__/tool-result-summarizer.test',
  './tool-input-summarizer.test',
  './tool-activity-accumulator.test',
  './opencode-event-normalizer.test',
  './hook-engine.test',
  // ─── Run 21: Coverage expansion — chat / handlers / MCP ───
  './sanitize-prompt-input.test',
  './mode-permissions.test',
  './system-prompt-cache.test',
  './context-budget-auditor.test',
  './structured-output-repair.test',
  './session-event-router.test',
  './agent-stream-processor.test',
  './chat-agent.service.test',
  // ─── Run 22: Coverage expansion — health / grilling / embeddings ───
  './indexing-diagnostics.test',
  './quality-gate-runner.test',
  './council-parser.test',
  './mpa-artifact-parsers.test',
  './ollama-manager.test',
  './omlx-manager.test',
  './grill-parsers.test',
  // ─── Run 23: Coverage expansion — parser / dispatch / resolver family ───
  './audit-response-parser.test',
  './mpa-campaign-retry.test',
  '../../ipc/__tests__/text-delta-batcher.test',
  './prompt-variant.test',
  './env-utils.test',
  './context-window-resolver.test',
  './agent-recovery-nudge.test',
  '../../ipc/__tests__/chunk-router.test',
  './grill-plan-mapper.test',
  // ─── Run 24: stdin-safe one-shot Claude CLI runner ───
  './claude-cli-oneshot.test',
  // ─── Run 25: Unified token usage logging (usage_log sink) ───
  './usage-tracker.service.test',
  './one-shot-claude.test',
  // ─── Run 26: Plan-mode UX — ask_user registry (no-timeout) + before-plan guard ───
  '../../mcp-servers/__tests__/ask-user-registry.test',
  './ask-user-guard.test',
  // ─── Run 27: Executor family + audit/parsing pipeline ───
  './tool-tracker.test',
  './token-accountant.test',
  './heartbeat-monitor.test',
  './stream-normalizer.test',
  './ndjson-parser.test',
  './output-cap.test',
  './audit-coverage-tracker.test',
  './audit-prompt-templates.test',
  './claude-md-generator.test',
  './workspace-deploy-parsing.test',
  // ─── Run 28: ChatStreamService decomposition (lifecycle method extraction) ───
  './chat-stream-lifecycle.test',
  // ─── Run 29: Prompt/Skill assembly + executor telemetry + listener cleanup + sandbox ───
  './telemetry-recorder.test',
  '../../ipc/__tests__/listener-cleanup.test',
  './prompt-builder.test',
  './skill-prompt-composer.test',
  './sandbox-config.test',
  // ─── Run 30: Blueprint pipeline — parsers, conditions, review service, build service ───
  './blueprint-parsers-conditions.test',
  './blueprint-review.service.test',
  './blueprint-build.service.test',
  './blueprint-verify-conditions.test',
  // ─── Run 31: Plan Hub — unified plan registry ───
  './audit-plan-mapper.test',
  './plan-registry.test',
  // ─── Run 32: Library Documentation Service (three-tier lookup) ───
  './library-doc-service.test',
  // ─── Run 33: ESLint MCP tools (output parsing, summary formatting, error handling) ───
  './eslint-mcp-tools.test',
  './analyze-complexity.test',
  // ─── Run 34: Adapter family + session accessors + blueprint/eval pure functions ───
  './evaluation-mcp-config.test',
  './mpa-base-adapter.test',
  './grill-adapter.test',
  './greenfield-grill-adapter.test',
  './blueprint-service-logic.test',
  './cli-mcp-config-writer-logic.test',
  // ─── Run 35: Adapter subclass family + pure functions + config builders ───
  './mpa-planner-adapter.test',
  './mpa-verifier-adapter.test',
  './mpa-builder-adapter.test',
  './blueprint-base-adapter.test',
  './blueprint-build-adapter.test',
  './blueprint-verify-adapter.test',
  './repo-service-pure.test',
  './opencode-config-writer-logic.test',
  './opencode-config-schema.test',
  './opencode-cli-check.test',
  './opencode-path-augmentation.test',
  './description-cache-pure.test',
  './workspace-mcp-config-logic.test',
  // ─── Run 35b: Phase 13 coverage mega-push — adapters, pure functions, repositories ───
  './blueprint-remaining-adapters.test',
  './council-member-adapter.test',
  './council-chairman-adapter.test',
  './audit-adapter.test',
  './skill-tiers-parser.test',
  './parse-plan-payload.test',
  './specialist-builder-pure.test',
  './blueprint-prompt-loader-pure.test',
  './repository-maprow-logic.test',
  './base-adapter-strategies.test',
  './heuristic-description-logic.test',
  './event-logger-service.test',
  '../../mcp-servers/__tests__/mcp-server-registration.test',
  // ─── Run 36: Phase 14 coverage mega-push — IPC registration, executors, service methods ───
  './cli-executor-args.test',
  './opencode-executor-pure.test',
  './agent-session-deep.test',
  './chat-stream-methods.test',
  './mpa-orchestration-helpers.test',
  './council-service-helpers.test',
  './grill-agent-helpers.test',
  './audit-agent-helpers.test',
  './grill-persistence-logic.test',
  './council-persistence-logic.test',
  './shared-types-coverage.test',
  './blueprint-spec-helpers.test',
  './plan-registry-helpers.test',
  './zero-coverage-services.test',
  // ─── Phase 15: Coverage Mega-Push — pure function tests ───
  './default-prompts-constants.test',
  './preprocessing-pure.test',
  './vector-search-pure.test',
  // ─── Phase 16: Coverage Mega-Push II — types, services, IPC, MCP ───
  './type-coverage.test',
  './mpa-orchestration-deep.test',
  './service-mid-coverage-deep.test',
  '../../ipc/__tests__/ipc-zero-coverage.test',
  '../../ipc/__tests__/ipc-blueprint-handlers.test',
  '../../ipc/__tests__/ipc-audit-handlers.test',
  '../../ipc/__tests__/ipc-crud-deep.test',
  '../../mcp-servers/__tests__/mcp-server-tools-deep.test',
  // ─── MCP tool consistency (cross-validates evaluation/advisor/prompt against canonical registry) ───
  './mcp-tool-consistency.test',
  // ─── OpenCode error pipeline (normalizer → processor end-to-end) ───
  './opencode-error-pipeline.test',
  // ─── Phase 17: Coverage Mega-Push III — IPC handler bodies, service instances, adapters ───
  '../../ipc/__tests__/ipc-handler-bodies.test',
  './service-instance-deep.test',
  './blueprint-pipeline-instance.test',
  './adapter-branch-push.test',
  './migration-metadata.test',
  // ─── Blueprint retry + CLI error-path tests ───
  './blueprint-retry.test',
  // ─── Native /goal support (CLI executor goal queuing + enforcement) ───
  './cli-executor-goal.test',
  // ─── Blueprint store guard (workspace event adoption logic) ───
  './blueprint-store-guard.test',
  // ─── Blueprint phase-chain map ───
  './blueprint-phase-chain.test',
  // ─── Blueprint Clarify Redesign — parsers + gate logic ───
  './blueprint-clarify-parsers.test',
  './blueprint-clarify-gate.test',
  // ─── Blueprint Pipeline Hardening — state machine ───
  './blueprint-state-machine.test',
  // ─── Blueprint Pipeline Stall Fix + Chunk Forwarder ───
  './blueprint-recovery-gating.test',
  './blueprint-chunk-forwarder.test',
  // ─── Pipeline Stabilization Round 2 — phase watchdog ───
  './blueprint-phase-watchdog.test',
  // ─── Blueprint Crash Recovery & Resume ───
  './blueprint-resume.test',
  // ─── Blueprint Discoveries Ledger ───
  './blueprint-discoveries.test',
  // ─── CLI executor killProcess deadlock regression ───
  './cli-executor-kill.test',
  // ─── Prompt Optimizer ───
  './prompt-optimizer.test',
  // ─── Cross-provider model roles — resolveAssignment + resolveModelAction ───
  './resolve-assignment.test',
  // ─── Snapshot model resolver — blueprint IDs + conversation snapshots ───
  './snapshot-resolver.test',
  // ─── Memory Engine (knowledge-aware) ───
  './memory-engine.test',
  './memory-retrieval.test',
  './memory-extraction.test',
  './memory-doc-watcher.test',
  // ─── Memory Graph (knowledge graph edge derivation) ───
  './memory-graph.test',
  // ─── Memory Consolidation (cluster merge, idle job) ───
  './memory-consolidation.test',
  './memory-consolidation-archival.test',
  // ─── E2E Testing Infrastructure ───
  './e2e-contracts.test',
  // ─── Blueprint document loader (splitBinaryDocs, buildReferenceDocsBlock) ───
  './blueprint-document-loader.test',
  // ─── Blueprint durability (journal mapper, viewState precedence) ───
  './blueprint-durability.test',
  // ─── Blueprint agent accumulator (flush boundaries, caps, cancel, taskId) ───
  './blueprint-agent-accumulator.test',
  // ─── Phase 18: Coverage Mega-Push IV — giant services deep + MCP tool bodies ───
  './giant-services-deep.test',
  '../../mcp-servers/__tests__/mcp-tool-bodies.test',
  './adapter-completion-round2.test',
  './coverage-mega-push-phase18.test',
  './coverage-push-phase18b.test',
  // ─── Blueprint clarify ask_user bridge (B1–B4 fixes) ───
  './blueprint-clarify-askuser.test',
  // ─── Memory Capture Expansion (blueprint/grill/document hooks) ───
  './memory-extraction-content.test',
  './blueprint-memory-hooks.test',
  './grill-memory-sync.test',
  // ─── Blueprint MCP tool availability fix (W1–W3) ───
  './mcp-skip-servers.test',
  // ─── Document Ingestion (reader, chunker, orchestration service) ───
  './document-chunker.test',
  './document-reader.test',
  './memory-ingestion.test',
  './memory-bootstrap.test',
  // ─── Local-LLM hermeticity fixes (FK guard + recovery gating) ───
  './local-plan-state-fk-guard.test',
  // ─── Phase 19 deep coverage ───
  './session-stream-deep-phase19.test',
  './executor-deep-phase19.test',
  './blueprint-services-deep.test',
  './orchestrator-pipeline-deep.test',
  './memory-vector-deep.test',
  './mcp-servers-deep.test',
  // ─── Agentic Claude runner (Deep Scan + CLAUDE.md regen shared helper) ───
  './agentic-claude-runner.test',
  // ─── Unified Handoff Protocol (types, adapters, rendering, redaction) ───
  './handoff.service.test',
  // ─── Blueprint Verify Extractor (post-hoc structured extraction) ───
  './blueprint-verify-extractor.test',
  // ─── OS Notification Service (dispatch routing, rate limiting, preferences) ───
  './notification.service.test',
  // ─── Phase 20A: Coverage Mega-Push VI — giant services deep ───
  './agent-session-body-deep.test',
  './chat-stream-body-deep.test',
  './code-analysis-handlers.test',
  './blueprint-spec-deep.test',
  // ─── Parallel Wave-Task Scheduler ───
  './blueprint-parallel-scheduler.test',
  // ─── Phase 21: Coverage Mega-Push ───
  './memory-engine-extraction-deep.test',
  './blueprint-services-deep-phase21.test',
  './council-mpa-grill-services-deep.test',
  './quick-win-coverage-boost.test',
  './ipc-conversation-handlers.test',
  './ipc-workspace-agent-handlers.test',
  './ipc-grill-audit-council-handlers.test',
  './ipc-remaining-handlers.test',
  // ─── MCP tool error handling + native module smoke ───
  '../../mcp-servers/__tests__/mcp-tool-error-handling.test',
  '../../mcp-servers/__tests__/native-module-smoke.test',
  // ─── Blueprint Environment Preflight (dependency validation before BUILD) ───
  './blueprint-preflight.test',
  // ─── Blueprint Task Verification (deterministic disk check after BUILD tasks) ───
  './blueprint-task-verification.test',
  // ─── Blueprint Send Outcome (session outcome surfacing + scheduling logic) ───
  './blueprint-send-outcome.test',
  // ─── Verify phase dual-field remediation read (phase-summaries parity) ───
  './phase-summaries-verify.test',
  // ─── Permission Prompt Flow (registry, stream-normalizer, tool-chunk-processor) ───
  './permission-prompt-flow.test',
  // ─── Background CLI Session (persistent warm process for prompt optimizer) ───
  './background-cli-session.test',
  // ─── PR Description Generation (CHAT_GENERATE_PR_DESCRIPTION handler logic) ───
  './pr-description-generation.test',
  // ─── Executor derivation (Phase A: provider → backend mapping) ───
  './executor-derivation.test',
  // ─── Local embedding provider facade (oMLX/Ollama routing) ───
  './local-embedding-provider.test',
]

// ─── Dynamic import loop with per-file error isolation ───
// Wrapped in async IIFE because the project is CJS (no top-level await).
void (async () => {
  let loadFailures = 0
  for (const file of TEST_FILES) {
    try {
      await import(file)
    } catch (err) {
      console.error(`\n[run-tests] FAILED to load ${file}:`, err)
      loadFailures++
    }
  }

  if (loadFailures > 0) {
    console.error(`\n[run-tests] ${loadFailures} file(s) failed to load`)
    process.exitCode = 1
  }
  console.log(`[run-tests] all ${TEST_FILES.length} test modules loaded (${loadFailures} load failure(s))`)

  // Await every async test queued by the harness before printing the aggregate
  // summary and exiting. Individual test files guard their own summaryAsync()
  // calls with `if (import.meta.url === ...)` so they only exit when run standalone.
  await summaryAsync()
})()

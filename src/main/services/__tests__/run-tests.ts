// Migration test runner entrypoint (used by: npx tsx src/main/services/__tests__/run-tests.ts)
//
// Uses dynamic imports in a sequential loop so that:
//   1. Any file that fails to load reports loudly (no silent truncation)
//   2. A completeness sentinel prints after all files are loaded
//   3. Individual file failures don't block the rest of the suite
import { setupElectronStub } from './electron-stub'
import { summaryAsync, drainPending } from './test-harness'
import { restoreFullMock } from './setup-full-mock'

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
  './code-graph-typed-edges.test',
  './code-graph-typed-tags-smoke.test',
  './code-graph-query-pack.test',
  './rationale-miner.test',
  './is-excluded-path.test',
  './index-exclusion-preflight.test',
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
  './specialist-ingestion-gate.test',
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
  '../../mcp-servers/__tests__/permission-result.test',
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
  './stream-wedge-recovery.test',
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
  './complexity-analyzer.test',
  './dotnet-lint.test',
  './cli-executor-process-identity.test',
  './cli-executor-spawn-guards.test',
  './cli-interrupt-cancel.test',
  '../../../renderer/src/store/__tests__/safety-timeout-policy.test',
  '../../../renderer/src/store/__tests__/safety-timeout-orphan.test',
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
  './repo-service-git.test',
  './track.service.test',
  './worktree-isolation-default.test',
  '../../../renderer/src/store/__tests__/code-changes-errors.test',
  './file-diff-state.test',
  './file-change-list-state.test',
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
  './plan-tasks.test',
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
  './memory-extraction-cancel.test',
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
  './ipc-bridge-tcp.test',
  // ─── Blueprint clarify ask_user bridge (B1–B4 fixes) ───
  './blueprint-clarify-askuser.test',
  // ─── Blueprint clarify question re-surfacing + findings-only nudge ───
  './blueprint-clarify-resurface.test',
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
  './memory-bootstrap-doc-state.test',
  './memory-bootstrap-queue.test',
  './memory-bootstrap-control.test',
  './memory-bootstrap-throughput.test',
  './instruction-sources.test',
  './scope-matcher.test',
  './memory-scope-activation.test',
  './memory-projection.test',
  './memory-retrieval-fusion.test',
  './memory-reflection.test',
  './memory-retrieval-tier-reinject.test',
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
  // ─── Blueprint → Chat handoff (intents, seed message, adapter intent) ───
  './blueprint-chat-handoff.test',
  './blueprint-handoff-options.test',
  './handoff-context-injection.test',
  // ─── Blueprint Verify Extractor (post-hoc structured extraction) ───
  './blueprint-verify-extractor.test',
  // ─── OS Notification Service (dispatch routing, rate limiting, preferences) ───
  './notification.service.test',
  // ─── Phase 20A: Coverage Mega-Push VI — giant services deep ───
  './agent-session-body-deep.test',
  // Read-after-send contract: response text must survive MEMLEAK-01 teardown
  './session-last-turn-text.test',
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
  './ipc-track-handlers.test',
  './mcp-config-worktree.test',
  './blueprint-track.test',
  './blueprint-branch-name.test',
  './landing.service.test',
  './track-claims.test',
  './lent-branch.test',
  './branch-options.test',
  // ─── MCP tool error handling + native module smoke ───
  '../../mcp-servers/__tests__/mcp-tool-error-handling.test',
  '../../mcp-servers/__tests__/native-module-smoke.test',
  // ─── Blueprint Environment Preflight (dependency validation before BUILD) ───
  './blueprint-preflight.test',
  './blueprint-gate-launch.test',
  // ─── Blueprint Task Verification (deterministic disk check after BUILD tasks) ───
  './blueprint-task-verification.test',
  './blueprint-task-user-skip.test',
  './blueprint-dependson-scheduling.test',
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
  // ─── Process Manager MCP server (ring buffer, tool registry, mode gating) ───
  './process-manager.test',
  './background-task-watcher.test',
  '../../ipc/__tests__/process-ipc.test',
  '../../../renderer/src/store/__tests__/stop-generation-reconcile.test',
  '../../../renderer/src/store/__tests__/workspace-switch-streams.test',
  '../../../renderer/src/store/__tests__/boot-streaming-rehydrate.test',
  '../../../renderer/src/hooks/__tests__/background-stream-routing.test',
  '../../../renderer/src/store/__tests__/update-snooze.test',
  '../../../renderer/src/store/__tests__/bootstrap-snapshot-patch.test',
  '../../../renderer/src/components/workspace/memory/bootstrap/__tests__/detail-line.test',
  '../../../renderer/src/components/workspace/memory/bootstrap/__tests__/scene-mode.test',
  '../../../renderer/src/components/workspace/memory/facts/__tests__/facts-model.test',
  '../../../renderer/src/components/workspace/memory/review/__tests__/word-diff.test',
  '../../../renderer/src/components/workspace/integrations/__tests__/integration-readiness.test',
  // ─── Phase 22: Coverage Mega-Push — pure functions, IPC validation, MCP helpers ───
  './validate-args-pure.test',
  './stream-helper-deep.test',
  './audit-handoff-service.test',
  './context-handoff-agent-sync.test',
  './chunk-router-metrics-deep.test',
  './preprocessing-repo-mappers.test',
  './chat-agent-executor-deep.test',
  './memory-ipc-workspace-ipc-deep.test',
  './mcp-servers-pure.test',
  // ─── Recall MCP server (past plans: registry ∪ message scan, dedupe, windows) ───
  './recall-server.test',
  // ─── Mermaid sanitizer pipeline (shared LLM output fixups) ───
  './mermaid-sanitizers.test',
  // ─── Loopback update feed server (cloud-drive auto-update transport) ───
  './update-feed-server.test',
  // ─── Update feed publishing + failure surfacing ───
  './feed-manifest-patch.test',
  './auto-update-helpers.test',
  './auto-update-service.test',
  // ─── Phase 24: IPC Coverage Blitz — 16 new IPC test files ───
  '../../ipc/__tests__/ipc-bug-idea-events.test',
  '../../ipc/__tests__/ipc-specialist-skill.test',
  '../../ipc/__tests__/ipc-code-graph-indexing.test',
  '../../ipc/__tests__/ipc-ollama-embedding.test',
  '../../ipc/__tests__/ipc-docs-repo-github.test',
  '../../ipc/__tests__/ipc-cost-token-log.test',
  '../../ipc/__tests__/ipc-app-preference-zoom.test',
  '../../ipc/__tests__/ipc-shell-sync-hooks.test',
  '../../ipc/__tests__/ipc-core-agent-alias-prompt.test',
  '../../ipc/__tests__/ipc-chat-lifecycle-shared.test',
  '../../ipc/__tests__/ipc-checkpoint-permission.test',
  '../../ipc/__tests__/ipc-workspace-project-session.test',
  '../../ipc/__tests__/ipc-chat-completion-mode.test',
  '../../ipc/__tests__/ipc-plan-sdk-handoff.test',
  '../../ipc/__tests__/ipc-workspace-deploy-testing.test',
  '../../ipc/__tests__/ipc-memory-deep.test',
  '../../ipc/__tests__/ipc-blueprint-deep.test',
  '../../ipc/__tests__/ipc-audit-deep.test',
  '../../ipc/__tests__/ipc-grill-mpa-council-deep.test',
  '../../ipc/__tests__/ipc-conversation-crud-deep.test',
  // ─── Phase 24: MCP Server Coverage ───
  '../../mcp-servers/__tests__/code-graph-server.test',
  '../../mcp-servers/__tests__/git-context-server.test',
  '../../mcp-servers/__tests__/control-actions-server.test',
  // ─── Phase 24: Zero-Coverage Services ───
  './subscription-auto-update.test',
  './docs-mermaid-filewatcher.test',
  // ─── Phase 24: Deep Tests for Low/Medium-Coverage Services ───
  './low-coverage-services-deep-phase24.test',
  './medium-coverage-augment-phase24.test',
  // ─── Phase 25: Wave 1 — Giant Services Deep Body Coverage ───
  './blueprint-build-deep-phase25.test',
  './agent-session-deep-phase25.test',
  './turn-poison.test',
  './chat-stream-deep-phase25.test',
  './opencode-executor-deep-phase25.test',
  './vector-search-deep-phase25.test',
  './blueprint-spec-deep-phase25.test',
  './blueprint-service-deep-phase25.test',
  './code-graph-deep-phase25.test',
  './blueprint-verify-deep-phase25.test',
  './memory-extraction-deep-phase25.test',
  // ─── Phase 25: Wave 2 — Pipeline Services Deep Coverage ───
  './mpa-orchestration-deep-phase25.test',
  './cli-executor-deep-phase25.test',
  './council-deep-phase25.test',
  './memory-engine-deep-phase25.test',
  './memory-bootstrap-deep-phase25.test',
  './audit-agent-deep-phase25.test',
  './workspace-deploy-deep-phase25.test',
  './grill-persistence-deep-phase25.test',
  // ─── Phase 25: Wave 3 — IPC Handler Body Deep Coverage ───
  '../../ipc/__tests__/ipc-blueprint-body-deep.test',
  '../../ipc/__tests__/ipc-audit-body-deep.test',
  '../../ipc/__tests__/ipc-mpa-council-body-deep.test',
  '../../ipc/__tests__/ipc-chat-completion-body.test',
  '../../ipc/__tests__/ipc-remaining-body-deep.test',
  // ─── Phase 25: Wave 4 — Medium Services + MCP ───
  './wave4-services-deep-phase25.test',
  '../../mcp-servers/__tests__/code-analysis-deep-phase25.test',
  // ─── Phase 25: Wave 5 — E2E Testing Infrastructure ───
  './e2e-assertions-deep-phase25.test',
  './e2e-runner-deep-phase25.test',
  './e2e-service-runners-phase25.test',
  // ─── Phase 25: Wave 6 — Remaining Repos & Adapters ───
  './wave6-repos-adapters-phase25.test',
  // ─── Phase 26: Wave 1 — Giant Service Bodies (Module-Mock Deep Body) ───
  './blueprint-build-body-p26.test',
  './agent-session-body-p26.test',
  './chat-stream-body-p26.test',
  './vector-search-body-p26.test',
  './opencode-exec-body-p26.test',
  './blueprint-spec-body-p26.test',
  './blueprint-svc-body-p26.test',
  './memory-extract-body-p26.test',
  './blueprint-verify-body-p26.test',
  './blueprint-ipc-body-p26.test',
  './memory-engine-body-p26.test',
  // ─── Phase 26: Wave 2 — IPC Handler Deep Body ───
  './audit-ipc-body-p26.test',
  './grill-ipc-body-p26.test',
  './convo-crud-ipc-body-p26.test',
  './mpa-ipc-body-p26.test',
  './chat-ipc-body-p26.test',
  './memory-ipc-body-p26.test',
  './workspace-ipc-body-p26.test',
  './remaining-ipc-body-p26.test',
  // ─── Phase 26: Wave 3 — Pipeline Service Method Bodies ───
  './memory-engine-pipeline-p26.test',
  './mpa-orch-body-p26.test',
  './memory-boot-body-p26.test',
  './cli-executor-body-p26.test',
  './council-body-p26.test',
  './audit-agent-body-p26.test',
  './workspace-deploy-body-p26.test',
  './grill-persist-body-p26.test',
  // ─── Phase 26: Wave 4 — Repository Deep Coverage ───
  './memory-fact-repo-deep-p26.test',
  './blueprint-repo-deep-p26.test',
  './audit-repo-deep-p26.test',
  './agent-session-repo-p26.test',
  './remaining-repos-p26.test',
  // ─── Phase 26: Wave 5 — Medium Services + MCP ───
  './code-analysis-mcp-p26.test',
  './preflight-body-p26.test',
  './skill-specialist-body-p26.test',
  './agent-sync-preprocessing-p26.test',
  './e2e-assertions-body-p26.test',
  // ─── Phase 26: Wave 6 — Adapters + Edge Cases ───
  './role-adapters-body-p26.test',
  './chat-agent-body-p26.test',
  './medium-services-batch-p26.test',
  './db-index-migrations-p26.test',
  // ─── Phase 27: Coverage Push — Pure Functions + Zero-Coverage Services ───
  './compaction-policy-p27.test',
  './handoff-redaction-p27.test',
  './mpa-prompts-p27.test',
  './audit-discovery-p27.test',
  './agent-executor-factory-p27.test',
  './handoff-adapters-p27.test',
  './one-shot-local-p27.test',
  './parsing-utils-p27.test',
  './structured-output-repair-p27.test',
  './github-service-p27.test',
  './event-logger-deep-p27.test',
  './opencode-config-writer-p27.test',
  './grill-persistence-deep-p27.test',
  './specialist-builder-deep-p27.test',
  // ─── Stale-turn incident: heartbeat tool ids, pending-tool leak, DB timestamps ───
  '../executor-utils/__tests__/tool-progress-heartbeat.test',
  '../executor-utils/__tests__/tool-tracker-leak.test',
  '../../ipc/__tests__/tool-chunk-progress.test',
  '../../../shared/__tests__/db-time.test',
  // ─── Truncated plan block: nested fence inside a JSON string value ───
  '../../../shared/__tests__/fenced-block.test',
  // ─── Registry drift repair ───
  // These existed on disk and were registered in run-all.ts (so they counted
  // toward coverage) but had never been added here, so `npm run test:unit`
  // silently skipped them. Verified green in isolation before registering.
  './agent-session-handlers.test',
  './auth-provider.test',
  './autofix-pr.test',
  './base-adapter.test',
  './blueprint-prompt-loader.test',
  './btw.test',
  './budget-exceeded-error.test',
  './chat-stream-handlers.test',
  './cli-mcp-config-builders.test',
  './code-graph-enhancements.test',
  './cost-tracker-pricing.test',
  './description-cache-handlers.test',
  './description-cache-makekey.test',
  './e2e-runner-deterministic.test',
  './event-logger-formatters.test',
  './event-logger.service.test',
  './file-service-utils.test',
  './github-service-checks.test',
  './grill-prompt-builders.test',
  './handoff-base-adapter-envelope.test',
  './heuristic-description-batch.test',
  './json-utils.test',
  './local-context-reconstructor.test',
  './model-config-utils.test',
  './opencode-config-data-registry.test',
  './opencode-executor-event-stream.test',
  './preprocessing-pipeline.test',
  './repo-service-utils.test',
  './scope-guard.test',
  './skill-enrichment-builders.test',
  './skill-tier-parser.test',
  './specialist-builder-handlers.test',
  './specialist-builder-logic.test',
  './task-execution-tracking.test',
  './usage-tracker-helpers.test',
  // These three asserted helpers their own doc comments described as exported
  // from the service, but which were module-private — so the tests could only
  // ever have failed. The helpers are now exported; see the commit for why
  // exporting was preferred to deleting the cases.
  './claude-md-generator-formatters.test',
  './language-detector.test',
  './local-plan-state-maprow.test',
  './tool-result-timeout.test',
  // Last of the drift batch — each needed a fix before it could be registered
  // (stale expectations, or assertions against methods that never existed).
  './budget-preflight.test',
  './event-logger-sequence.test',
  './grill-prompt-blocks.test',
  './opencode-agent-writer-builders.test',
  './opencode-config-writer-builders.test',
  './opencode-executor-logic.test',
  './prompt-builder-extractors.test',
  './prompt-builder-local.test',
  './workspace-mcp-config-builder.test',
  // ─── Jira MCP integration (credentials, connection test, bundled server) ───
  './integration-credentials.test',
  './jira-connection-test.test',
  './external-mcp-mount.test',
  './ipc-integrations-handlers.test',
  './jira-tickets.test',
  '../../mcp-servers/__tests__/jira-server.test',
  // ─── Plan section icon ids ───
  '../../../renderer/src/utils/__tests__/lucide-icon-by-name.test',
  // ─── Inline vs toast routing for permission requests ───
  '../../../renderer/src/lib/__tests__/permission-routing.test',
  // ─── BuildActionBar visibility (plan actioned / build running) ───
  '../../../renderer/src/components/chat/task-plan/__tests__/build-bar-visibility.test',
  // ─── Build Now kickoff must not re-trigger the build → plan auto-switch ───
  '../../../renderer/src/utils/__tests__/build-kickoff-mode-guard.test',
  // ─── Chat header naming (project specialist, raw agent ids) ───
  '../../../renderer/src/components/chat/__tests__/message-identity.test',
  // ─── Audit → Blueprint handoff formatting ───
  './audit-blueprint-handoff.test',
  // ─── Round 3: e2e-testing behavioral coverage ───
  './e2e-assertions-behavior.test',
  './e2e-service-runners-behavior.test',
  './e2e-runners-chat-checkpoint.test',
  './e2e-runners-mpa-grill-audit.test',
  './e2e-runners-idea-specialist.test',
  './e2e-runner-preflight.test'
]
// NOTE: is-excluded-path.test is registered early (after code-graph-logic)
// because summaryAsync() calls process.exit(), which can truncate stdout
// for tests near the end of the array.

// ─── Stray-rejection guard ───
// A fire-and-forget call inside one test that rejects with nobody awaiting it is
// an *unhandled rejection*, and Node's default policy for those is to throw —
// which kills this process mid-loop and silently abandons every file that had
// not been imported yet. That is not hypothetical: 36 rejections of
// `Error: Please check update first` (electron-updater, from the auto-update
// tests) were truncating this run at file 342 of 522, so 179 files never ran and
// contributed no coverage at all. A stray rejection is worth reporting, but it
// must never decide how much of the suite executes.
const strayRejections: unknown[] = []
process.on('unhandledRejection', (reason) => {
  strayRejections.push(reason)
})

// ─── Dynamic import loop with per-file error isolation ───
// Wrapped in async IIFE because the project is CJS (no top-level await).
void (async () => {
  let loadFailures = 0
  for (const file of TEST_FILES) {
    try {
      await import(file)
      // Let this file's async tests finish before the next file loads. Async
      // tests start eagerly, so without this every async test in the suite runs
      // concurrently — wall-clock budgets then measure event-loop contention,
      // and a file's tests can outlive the mocks they were written against.
      await drainPending()
    } catch (err) {
      console.error(`\n[run-tests] FAILED to load ${file}:`, err)
      loadFailures++
    } finally {
      // Undo setupFullMock()'s Module._load patch (if this file installed it)
      // before the next file loads — mirrors src/main/__tests__/run-all.ts.
      // Without this, the very first file to call setupFullMock() leaves
      // Module._load hijacked for every file loaded afterward in this same
      // process: every subsequent `require('../db/repositories')`-style call
      // (from test files AND from the production code they exercise) starts
      // silently resolving to the fake in-memory mock instead of the real
      // module, while any production module already cached from an EARLIER
      // require keeps its real (unmocked) binding — the resulting split
      // identity is what caused e.g. prompt-optimizer.test.ts's settings
      // monkey-patch to land on a different `workspaceRepository` object
      // than the one prompt-optimizer.service.ts actually reads from.
      restoreFullMock()
    }
  }

  if (loadFailures > 0) {
    console.error(`\n[run-tests] ${loadFailures} file(s) failed to load`)
    process.exitCode = 1
  }
  console.log(
    `[run-tests] all ${TEST_FILES.length} test modules loaded (${loadFailures} load failure(s))`
  )

  if (strayRejections.length > 0) {
    const kinds = new Map<string, number>()
    for (const r of strayRejections) {
      const key = r instanceof Error ? `${r.name}: ${r.message}` : String(r)
      kinds.set(key, (kinds.get(key) ?? 0) + 1)
    }
    console.warn(
      `\n[run-tests] ${strayRejections.length} unhandled rejection(s) were absorbed so the run could finish:`
    )
    for (const [kind, count] of kinds) console.warn(`  ${count}x ${kind}`)
  }

  // Await every async test queued by the harness before printing the aggregate
  // summary and exiting. Individual test files guard their own summaryAsync()
  // calls with `if (import.meta.url === ...)` so they only exit when run standalone.
  await summaryAsync()
})()

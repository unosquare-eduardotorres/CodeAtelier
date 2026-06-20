// Migration test runner entrypoint (used by: npx tsx src/main/services/__tests__/run-tests.ts)
import { summaryAsync } from './test-harness'
import './generalist-migration.test'
import './event-sequence.test'
import './agent-services.test'
import './mcp-server-service.test'
import './preprocessing.test'
import './description-cache.test'
import './code-graph-logic.test'
import './vector-search.test'
import './code-graph-db.test'
import './mcp-tool-wiring.test'
import './path-traversal.test'
import './control-actions.test'
import './conversation-state-machine.test'
import './intent-detector.test'
import './intent-router.test'
// Run 3 — P0 continued
import './agent-circuit-breaker.test'
import './da-vinci-prompt-assembler.test'
// Run 4 — P1 targets
import './cost-tracker.test'
import './agent-token-tracker.test'
import './elicitation.test'
// Run 5 — P1 expansion
import './model-config.test'
import './opus-48-thinking.test'
import './session-recovery.test'
import './health-check.test'
// Run 6 — lifecycle
import './conversation-lifecycle.test'
// Run 6b — Project Specialist refactor (Phase 1)
import './agent-session.service.test'
import './da-vinci-adapter.test'
// Run 6c — Project Specialist refactor (Phase 2)
import './prompt-assembly-helpers.test'
import './project-specialist-prompt-template.test'
import './project-specialist-adapter.test'
import './stack-drift-detector.test'
import './tech-stack-detector.test'
import './specialist-builder-meta-prompt.test'
// Run 6d — Phase 4 cleanup
import './layer2-rename-migration.test'
// Run 7 — IPC protocol + input validation (in ../../ipc/__tests__/)
import '../../ipc/__tests__/chat-protocol.test'
import '../../ipc/__tests__/validate-args.test'
// Run 8 — bubble identity / role tagging / consent regression
import './chat-stream-role-tagging.test'
import './resolve-adapter-consent.test'
import '../../ipc/__tests__/chat-swap-handler.test'
// Run 9 — renderer utilities (pure logic, no DOM)
import './sentence-buffer.test'

// ─── Run 11: Prompt optimization (Opus 4.8) ───
import './prompt-verbosity.test'
import './prompt-lean-identity.test'
import './prompt-lean-mode.test'

// ─── Run 12: MPA (Multi-Phased Agent Pipeline) ───
import './mpa-goal-conditions.test'
import './mpa-preflight.test'
import './mpa-orchestration.test'
import './goal-decomposer.test'
import './mpa-verify-criteria.test'
import './multi-session.test'

// ─── Run 13: Council (LLM Council) ───
import './council.service.test'

// ─── Run 14: Grill Plan + Resume ───
import './grill-plan-and-resume.test'
import './grill-plan-from-decisions.test'
import './grill-handoff-utils.test'

// ─── Run 15: Tool Chunk Processor (centralized pipeline) ───
import '../../ipc/__tests__/tool-chunk-processor.test'

// ─── Run 16: Context usage level/quality resolution ───
import './context-usage-level.test'

// ─── Run 17: Context compaction verification (badge + thresholds + local) ───
import './compaction-thresholds.test'
import './local-compaction.test'
import './auto-compact-options.test'

// ─── Run 18: Llamafile embedding sidecar manager ───
import './llamafile-embedding.test'

// ─── Run 19: Previously-orphaned test files (registered for coverage) ───
import './context-management.test'
import './workspace-mcp-config-tiers.test'
import './tag-to-chunk-adapter.test'
import './skill-summary.test'
import './prompt-assembler-turn-count.test'
import './agent-session-token-split.test'

// ─── Run 20: Coverage expansion — streaming / tools / hooks (pure logic) ───
import './thinking-parser.test'
import '../../ipc/__tests__/tool-result-summarizer.test'
import './tool-input-summarizer.test'
import './tool-activity-accumulator.test'
import './opencode-event-normalizer.test'
import './hook-engine.test'

// ─── Run 21: Coverage expansion — chat / handlers / MCP ───
import './sanitize-prompt-input.test'
import './mode-permissions.test'
import './system-prompt-cache.test'
import './context-budget-auditor.test'
import './structured-output-repair.test'
import './session-event-router.test'
import './agent-stream-processor.test'
import './chat-agent.service.test'

// ─── Run 22: Coverage expansion — health / grilling / embeddings ───
import './indexing-diagnostics.test'
import './quality-gate-runner.test'
import './council-parser.test'
import './mpa-artifact-parsers.test'
import './ollama-manager.test'
import './omlx-manager.test'
import './grill-parsers.test'

// ─── Run 23: Coverage expansion — parser / dispatch / resolver family ───
import './audit-response-parser.test'
import './mpa-campaign-retry.test'
import '../../ipc/__tests__/text-delta-batcher.test'
import './prompt-variant.test'
import './env-utils.test'
import './context-window-resolver.test'
import './agent-recovery-nudge.test'
import '../../ipc/__tests__/chunk-router.test'
import './grill-plan-mapper.test'

// ─── Run 24: stdin-safe one-shot Claude CLI runner ───
import './claude-cli-oneshot.test'

// ─── Run 25: Unified token usage logging (usage_log sink) ───
import './usage-tracker.service.test'
import './one-shot-claude.test'

// ─── Run 26: Plan-mode UX — ask_user registry (no-timeout) + before-plan guard ───
import '../../mcp-servers/__tests__/ask-user-registry.test'
import './ask-user-guard.test'

// ─── Run 27: Executor family + audit/parsing pipeline ───
import './tool-tracker.test'
import './token-accountant.test'
import './heartbeat-monitor.test'
import './stream-normalizer.test'
import './ndjson-parser.test'
import './output-cap.test'
import './audit-coverage-tracker.test'
import './audit-prompt-templates.test'
import './claude-md-generator.test'
import './workspace-deploy-parsing.test'

// ─── Run 28: ChatStreamService decomposition (lifecycle method extraction) ───
import './chat-stream-lifecycle.test'

// ─── Run 29: Prompt/Skill assembly + executor telemetry + listener cleanup + sandbox ───
import './telemetry-recorder.test'
import '../../ipc/__tests__/listener-cleanup.test'
import './prompt-builder.test'
import './skill-prompt-composer.test'
import './sandbox-config.test'

// ─── Run 30: Blueprint pipeline — parsers, conditions, review service, build service ───
import './blueprint-parsers-conditions.test'
import './blueprint-review.service.test'
import './blueprint-build.service.test'
import './blueprint-verify-conditions.test'

// ─── Run 31: Plan Hub — unified plan registry ───
import './audit-plan-mapper.test'
import './plan-registry.test'

// ─── Run 32: Code Graph enhancements — blast_radius, co_change, hotspot_score, code_clones ───
import './code-graph-enhancements.test'

// ─── Run 33: Phase 10 Coverage Push — 57% → 60% ───
import './repo-service-utils.test'
import './base-adapter.test'
import './specialist-builder-logic.test'

// Await every async test queued by the harness before printing the aggregate
// summary and exiting. Individual test files guard their own summary() calls
// with `if (import.meta.url === file://${process.argv[1]})` so they only
// exit when run standalone.
void summaryAsync()

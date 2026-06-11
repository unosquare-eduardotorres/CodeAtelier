/**
 * Unified test entrypoint for coverage runs.
 *
 * Imports every registered test file (services + repositories + IPC) and
 * calls `summaryAsync()` exactly once so a single `c8 tsx ...` invocation
 * produces one merged coverage report.
 *
 * NOTE: This file deliberately imports each test file directly rather than
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

// ─────────────────────────────────────────────────────────────────────────────
// Service tests (mirrors src/main/services/__tests__/run-tests.ts)
// ─────────────────────────────────────────────────────────────────────────────
import '../services/__tests__/generalist-migration.test'
import '../services/__tests__/event-sequence.test'
import '../services/__tests__/agent-services.test'
import '../services/__tests__/mcp-server-service.test'
import '../services/__tests__/preprocessing.test'
import '../services/__tests__/description-cache.test'
import '../services/__tests__/code-graph-logic.test'
import '../services/__tests__/vector-search.test'
import '../services/__tests__/code-graph-db.test'
import '../services/__tests__/mcp-tool-wiring.test'
import '../services/__tests__/path-traversal.test'
import '../services/__tests__/control-actions.test'
import '../services/__tests__/conversation-state-machine.test'
import '../services/__tests__/intent-detector.test'
import '../services/__tests__/intent-router.test'
// Run 3 — P0 continued
import '../services/__tests__/agent-circuit-breaker.test'
import '../services/__tests__/da-vinci-prompt-assembler.test'
// Run 4 — P1 targets
import '../services/__tests__/cost-tracker.test'
import '../services/__tests__/agent-token-tracker.test'
import '../services/__tests__/elicitation.test'
// Run 5 — P1 expansion
import '../services/__tests__/model-config.test'
import '../services/__tests__/opus-48-thinking.test'
import '../services/__tests__/session-recovery.test'
import '../services/__tests__/health-check.test'
// Run 6 — lifecycle
import '../services/__tests__/conversation-lifecycle.test'
// Run 6b — Project Specialist refactor (Phase 1)
import '../services/__tests__/agent-session.service.test'
import '../services/__tests__/da-vinci-adapter.test'
// Run 6c — Project Specialist refactor (Phase 2)
import '../services/__tests__/prompt-assembly-helpers.test'
import '../services/__tests__/project-specialist-prompt-template.test'
import '../services/__tests__/project-specialist-adapter.test'
import '../services/__tests__/stack-drift-detector.test'
import '../services/__tests__/tech-stack-detector.test'
import '../services/__tests__/specialist-builder-meta-prompt.test'
// Run 6d — Phase 4 cleanup
import '../services/__tests__/layer2-rename-migration.test'

// ─────────────────────────────────────────────────────────────────────────────
// IPC tests (mirrors trailing imports in services/__tests__/run-tests.ts)
// ─────────────────────────────────────────────────────────────────────────────
import '../ipc/__tests__/chat-protocol.test'
import '../ipc/__tests__/validate-args.test'
// Run 8 — bubble identity / role tagging / consent regression
import '../services/__tests__/chat-stream-role-tagging.test'
import '../services/__tests__/resolve-adapter-consent.test'
import '../ipc/__tests__/chat-swap-handler.test'
// Run 9 — renderer utilities (pure logic, no DOM)
import '../services/__tests__/sentence-buffer.test'

// ─── Run 11: Prompt optimization (Opus 4.8) ───
import '../services/__tests__/prompt-verbosity.test'
import '../services/__tests__/prompt-lean-identity.test'
import '../services/__tests__/prompt-lean-mode.test'

// ─── Run 12: MPA (Multi-Phased Agent Pipeline) ───
import '../services/__tests__/mpa-goal-conditions.test'
import '../services/__tests__/mpa-preflight.test'
import '../services/__tests__/mpa-orchestration.test'
import '../services/__tests__/goal-decomposer.test'
import '../services/__tests__/mpa-verify-criteria.test'
import '../services/__tests__/multi-session.test'

// ─── Run 13: Council (LLM Council) ───
import '../services/__tests__/council.service.test'

// ─── Run 14: Grill Plan + Resume ───
import '../services/__tests__/grill-plan-and-resume.test'
import '../services/__tests__/grill-plan-from-decisions.test'
import '../services/__tests__/grill-handoff-utils.test'

// ─── Run 15: Tool Chunk Processor (centralized pipeline) ───
import '../ipc/__tests__/tool-chunk-processor.test'

// ─── Run 16: Context usage level/quality resolution ───
import '../services/__tests__/context-usage-level.test'

// ─── Run 17: Context compaction verification (badge + thresholds + local) ───
import '../services/__tests__/compaction-thresholds.test'
import '../services/__tests__/local-compaction.test'
import '../services/__tests__/auto-compact-options.test'

// ─── Run 18: Llamafile embedding sidecar manager ───
import '../services/__tests__/llamafile-embedding.test'

// ─── Run 19: Previously-orphaned test files (registered for coverage) ───
import '../services/__tests__/context-management.test'
import '../services/__tests__/workspace-mcp-config-tiers.test'
import '../services/__tests__/tag-to-chunk-adapter.test'
import '../services/__tests__/skill-summary.test'
import '../services/__tests__/prompt-assembler-turn-count.test'
import '../services/__tests__/agent-session-token-split.test'

// ─── Run 20: Coverage expansion — streaming / tools / hooks (pure logic) ───
import '../services/__tests__/thinking-parser.test'
import '../ipc/__tests__/tool-result-summarizer.test'
import '../services/__tests__/tool-input-summarizer.test'
import '../services/__tests__/tool-activity-accumulator.test'
import '../services/__tests__/opencode-event-normalizer.test'
import '../services/__tests__/hook-engine.test'

// ─── Run 21: Coverage expansion — chat / handlers / MCP ───
import '../services/__tests__/sanitize-prompt-input.test'
import '../services/__tests__/mode-permissions.test'
import '../services/__tests__/system-prompt-cache.test'
import '../services/__tests__/context-budget-auditor.test'
import '../services/__tests__/structured-output-repair.test'
import '../services/__tests__/session-event-router.test'
import '../services/__tests__/agent-stream-processor.test'
import '../services/__tests__/chat-agent.service.test'

// ─── Run 22: Coverage expansion — health / grilling / embeddings ───
import '../services/__tests__/indexing-diagnostics.test'
import '../services/__tests__/quality-gate-runner.test'
import '../services/__tests__/council-parser.test'
import '../services/__tests__/mpa-artifact-parsers.test'
import '../services/__tests__/mpa-campaign-retry.test'
import '../services/__tests__/ollama-manager.test'
import '../services/__tests__/omlx-manager.test'
import '../services/__tests__/grill-parsers.test'

// ─── Run 23: Coverage expansion — parser / dispatch / resolver family ───
import '../services/__tests__/audit-response-parser.test'
import '../ipc/__tests__/text-delta-batcher.test'
import '../services/__tests__/prompt-variant.test'
import '../services/__tests__/env-utils.test'
import '../services/__tests__/context-window-resolver.test'
import '../services/__tests__/agent-recovery-nudge.test'
import '../ipc/__tests__/chunk-router.test'
import '../services/__tests__/grill-plan-mapper.test'

// ─── Run 24: stdin-safe one-shot Claude CLI runner ───
import '../services/__tests__/claude-cli-oneshot.test'

// ─── Run 25: Unified token usage logging (usage_log sink) ───
import '../services/__tests__/usage-tracker.service.test'
import '../services/__tests__/one-shot-claude.test'

// ─── Run 26: Plan-mode UX — ask_user registry (no-timeout) + before-plan guard ───
import '../mcp-servers/__tests__/ask-user-registry.test'
import '../services/__tests__/ask-user-guard.test'

// ─── Run 27: Executor family + audit/parsing pipeline ───
import '../services/__tests__/tool-tracker.test'
import '../services/__tests__/token-accountant.test'
import '../services/__tests__/heartbeat-monitor.test'
import '../services/__tests__/stream-normalizer.test'
import '../services/__tests__/ndjson-parser.test'
import '../services/__tests__/output-cap.test'
import '../services/__tests__/audit-coverage-tracker.test'
import '../services/__tests__/audit-prompt-templates.test'
import '../services/__tests__/claude-md-generator.test'
import '../services/__tests__/workspace-deploy-parsing.test'

// ─── Run 28: ChatStreamService decomposition (lifecycle method extraction) ───
import '../services/__tests__/chat-stream-lifecycle.test'

// ─── Run 29: Prompt/Skill assembly + executor telemetry + listener cleanup + sandbox ───
import '../services/__tests__/telemetry-recorder.test'
import '../ipc/__tests__/listener-cleanup.test'
import '../services/__tests__/prompt-builder.test'
import '../services/__tests__/skill-prompt-composer.test'
import '../services/__tests__/sandbox-config.test'

// ─────────────────────────────────────────────────────────────────────────────
// Repository tests (mirrors src/main/db/repositories/__tests__/run-tests.ts)
// ─────────────────────────────────────────────────────────────────────────────
import '../db/repositories/__tests__/message.repository.test'
import '../db/repositories/__tests__/conversation.repository.test'
import '../db/repositories/__tests__/workspace.repository.test'
import '../db/repositories/__tests__/usage-log.repository.test'
import '../db/repositories/__tests__/migration-v102.test'
// Single summary at the end — awaits all pending async tests, prints totals,
// and exits with code 1 on any failure.
import { summaryAsync } from '../services/__tests__/test-harness'
void summaryAsync()

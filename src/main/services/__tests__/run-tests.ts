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
import './code-graph-first-hook.test'
import './conversation-state-machine.test'
import './intent-detector.test'
import './intent-router.test'
// Run 3 — P0 continued
import './agent-circuit-breaker.test'
import './tool-approval.test'
import './da-vinci-prompt-assembler.test'
// Run 4 — P1 targets
import './cost-tracker.test'
import './agent-token-tracker.test'
import './elicitation.test'
// Run 5 — P1 expansion
import './abandonment-detector.test'
import './model-config.test'
import './opus-47-thinking.test'
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

// Await every async test queued by the harness before printing the aggregate
// summary and exiting. Individual test files guard their own summary() calls
// with `if (import.meta.url === file://${process.argv[1]})` so they only
// exit when run standalone.
void summaryAsync()

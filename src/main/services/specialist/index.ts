/**
 * Specialist orchestration module — clean abstractions for multi-agent execution.
 *
 * Extracted from SpecialistPoolService monolith to provide composable building blocks:
 * - Semaphore: Async concurrency control (with `run()` for auto-release)
 * - ExecutionTracer: Structured tracing with timing spans
 * - Trace Bridge: Automatic event bridging from tracer to persistent EventLogger
 * - SpecialistHookRunner: Typed lifecycle hooks (before/after/tool)
 * - MessageBus: Inter-agent pub/sub communication
 * - Scheduling strategies: Pluggable task prioritization
 * - Structured output: JSON extraction + Zod schema validation
 * - Task scheduler: Topological sort + conclusive pattern detection
 */

// ── Concurrency ──
export { Semaphore } from './semaphore'

// ── Tracing ──
export { ExecutionTracer, executionTracer, type TraceEvent, type TraceSpan } from './trace'

// ── Trace Bridge ──
export { bridgeTracerToEventLogger } from './trace-bridge'

// ── Hooks ──
export {
  SpecialistHookRunner,
  specialistHookRunner,
  type BeforeRunContext,
  type AfterRunResult
} from './hooks'

// ── Messaging ──
export {
  MessageBus,
  messageBus,
  type AgentMessage,
  type MessageType,
  type MessagePersistenceAdapter
} from './message-bus'

// ── Message Bus Persistence ──
export { bridgeBusToPersistence } from './bus-persistence'

// ── Scheduling ──
export {
  createScheduler,
  CompositeScheduler,
  type SchedulingStrategy,
  type AgentCapability,
  type SchedulingContext
} from './scheduling'

// ── Structured Output ──
export {
  extractJSON,
  validateInvestigationReport,
  validateWithSchema,
  buildFallbackReport,
  type ValidationResult
} from './structured-output'

// ── Structured Logging ──
export { createStructuredLogger } from './structured-log'

// ── Agent Context Persistence ──
export { agentContextService } from '../agent-context.service'

// ── Task Scheduler (existing) ──
export { topologicalSort, detectConclusivePattern } from './task-scheduler'

// ── Investigation Detection ──
export { isInvestigationIntent } from './investigation-detect'

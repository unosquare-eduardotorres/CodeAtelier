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
export {
  ExecutionTracer,
  executionTracer,
  type TraceEvent,
  type TraceEventType,
  type TraceSpan,
  type TraceTokenUsage,
  type TraceListener
} from './trace'

// ── Trace Bridge ──
export { bridgeTracerToEventLogger } from './trace-bridge'

// ── Hooks ──
export {
  SpecialistHookRunner,
  specialistHookRunner,
  type SpecialistHooks,
  type BeforeRunContext,
  type AfterRunResult,
  type ToolCallContext,
  type ToolResultContext
} from './hooks'

// ── Messaging ──
export {
  MessageBus,
  messageBus,
  type AgentMessage,
  type MessageType,
  type MessageSubscriber,
  type MessagePersistenceAdapter
} from './message-bus'

// ── Message Bus Persistence ──
export { bridgeBusToPersistence } from './bus-persistence'

// ── Scheduling ──
export {
  createScheduler,
  CompositeScheduler,
  type SchedulingStrategy,
  type SchedulingStrategyName,
  type AgentCapability,
  type SchedulingContext,
  type TaskPriority
} from './scheduling'

// ── Structured Output ──
export {
  extractJSON,
  validateInvestigationReport,
  validateWithSchema,
  InvestigationReportSchema,
  buildFallbackReport,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
  type ExtractionStrategy,
  // @deprecated — use validateWithSchema() with Zod schemas instead
  validateSchema,
  type FieldSchema
} from './structured-output'

// ── Structured Logging ──
export { createStructuredLogger, type SpecialistLogFields } from './structured-log'

// ── Agent Context Persistence ──
export { agentContextService } from '../agent-context.service'

// ── Task Scheduler (existing) ──
export {
  topologicalSort,
  detectConclusivePattern,
  getConclusivePatterns
} from './task-scheduler'

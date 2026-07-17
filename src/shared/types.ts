// ── Data Models ──
export type ConversationMode = 'plan' | 'build' | 'danger'
export type ConversationType = 'chat' | 'blueprint'

/** Thinking effort level — controls reasoning depth (thinking budget + temperature) */
export type ThinkingEffort = 'low' | 'medium' | 'high'

/** Prompt verbosity level — controls how much guardrailing the system prompt includes */
export type PromptVerbosity = 'full' | 'lean'

/**
 * Which agent role is driving an AgentSessionService.
 * - 'specialist' — the unified chat agent (formerly 'da-vinci' + 'project-specialist').
 *   Uses DEFAULT_ARCHITECT_PROMPT when no specialist row exists, otherwise uses the
 *   LLM-tailored prompt from the specialist builder.
 */
export type AgentRole =
  | 'specialist'
  | 'audit'
  | 'grill'
  | 'mpa-planner'
  | 'mpa-builder'
  | 'mpa-verifier'
  | 'council-member'
  | 'council-chairman'
  | 'blueprint-specify'
  | 'blueprint-clarify'
  | 'blueprint-plan'
  | 'blueprint-tasks'
  | 'blueprint-review'
  | 'blueprint-build'
  | 'blueprint-verify'

/** Communication tone for AI responses — workspace default + per-conversation override */
export type CommunicationTone = 'default' | 'calm' | 'optimistic' | 'brutal' | 'caveman'

/** Tracks which phase of the conversation lifecycle is active */
export type ConversationPhase = 'specialist-responding' | 'specialist-executing'

export interface UserProfile {
  id: string
  displayName: string
  avatarKey: string
  createdAt: string
  updatedAt: string
}

export interface CoreAgentAlias {
  agentRole: 'specialist'
  alias: string | null
  avatarKey: string | null
  updatedAt: string
}

export interface CoreAgentPrompt {
  id: string
  agentRole: 'specialist'
  mode: 'plan' | 'build' | 'danger'
  promptText: string
  defaultPromptText: string
  isCustom: boolean
  updatedAt: string
}

export interface Workspace {
  id: string
  name: string
  repoPath: string
  gitRemoteUrl?: string
  createdAt: string
  lastOpenedAt: string
  settingsJson: string
  isGitRepo: boolean
  constitutionMd?: string
  constitutionVersion?: string
}

export interface Conversation {
  id: string
  workspaceId: string
  title: string
  mode: ConversationMode
  /** Conversation type: 'chat' for normal conversations, 'blueprint' for blueprint phase conversations */
  type: ConversationType
  createdAt: string
  status: 'active' | 'archived'
  summary?: string
  /** Claude CLI session ID for --resume support (context persistence) */
  claudeSessionId?: string
  /** PR number created during /complete */
  prNumber?: number
  /** PR URL created during /complete */
  prUrl?: string
  /** Git branch name created during /complete */
  branchName?: string
  /** User-defined sort order for sidebar reordering */
  sortOrder?: number
  /** Specialist ID used as persona overlay (null = default specialist) */
  personaSpecialistId?: string | null
  /** LLM provider locked at conversation creation time */
  llmProvider: LLMProvider
  /** Per-chat external MCP toggles (e.g. { maestro: true }) */
  mcpOverrides?: Record<string, boolean>
  /** Per-conversation communication tone override (null = use workspace default) */
  communicationTone?: CommunicationTone | null
  /** Per-conversation thinking effort level */
  effort?: ThinkingEffort
  /** Per-conversation thinking budget cap — max thinking tokens per turn (0 = no limit) */
  thinkingBudget?: number
  /** Handoff context injected into system prompt when switching providers mid-chat */
  handoffContext?: string | null
  /** Frozen model configuration snapshot — NULL for legacy conversations (live resolution) */
  modelConfigSnapshot?: ConversationModelSnapshot | null
  /** Audit run ID when this conversation was created from the Health page */
  sourceAuditRunId?: string | null
}

/**
 * Frozen model configuration stored at conversation creation time.
 * Immutable — consumers read this instead of re-resolving live settings.
 * NULL on legacy conversations → fall back to live resolution.
 */
export interface ConversationModelSnapshot {
  /** Resolved model for plan mode */
  plan: ResolvedAssignment
  /** Resolved model for build mode */
  build: ResolvedAssignment
  /** Resolved model for background tasks */
  background: ResolvedAssignment
  /** ISO 8601 timestamp when snapshot was created */
  snapshotAt: string
}

export type ContextUsageLevel = 'green' | 'yellow' | 'red' | 'critical'

/**
 * Detailed Claude Code-style breakdown of what's filling the context window.
 * Mirrors SDKControlGetContextUsageResponse so we can render the same 8-category
 * panel + per-tool top-N table in the compact-context modal.
 */
export interface ContextUsageBreakdown {
  /** Top-level categories (Messages, System Prompt, Skills, MCP, Tools, etc.) */
  categories?: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  /** Per-tool MCP usage (server + tool name + tokens). */
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  /** Built-in system tools (Read, Write, Bash, …). */
  systemTools?: { name: string; tokens: number }[]
  /** SDK-deferred built-ins (loaded but unused). */
  deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[]
  /** Workspace memory files (CLAUDE.md, skills/, …). */
  memoryFiles?: { path: string; type: string; tokens: number }[]
  /** Auto-compact threshold (raw tokens) reported by the SDK, if available. */
  autoCompactThreshold?: number
  /** Whether the SDK has auto-compaction enabled. */
  isAutoCompactEnabled?: boolean
}

export interface ContextUsage {
  conversationId: string
  inputTokens: number
  contextWindowSize: number
  percentage: number
  level: ContextUsageLevel
  qualityLevel?: 'excellent' | 'good' | 'moderate' | 'low'
  /** Prompt cache hit rate (0–100) — ratio of cache-read tokens to total input. */
  cacheHitRate?: number
  /** SDK-native breakdown by category (system prompt, tools, messages, etc.) */
  categories?: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  /** Full Claude Code-style breakdown for the compact-context modal. */
  breakdown?: ContextUsageBreakdown
  /** Current model reported by SDK */
  model?: string
  /** Whether this was sourced from SDK (live) or DB (historical fallback) */
  source?: 'sdk' | 'db'
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'specialist'
  agentId?: string
  contentMd: string
  attachmentsJson: string
  createdAt: string
  toolActivities?: ToolActivity[]
  /** For turn bubbles: references the parent message ID that this bubble belongs to */
  parentMessageId?: string
  /** Which plan card action the user clicked: 'build' | 'refine' | 'save_as_idea' | 'council' */
  planAction?: string
}

export interface AgentStatus {
  agentId: string
  agentType: string
  status: 'idle' | 'thinking' | 'writing' | 'reviewing' | 'completed' | 'failed'
  currentTask?: string
  elapsedMs: number
  /** Workspace this status belongs to (multi-workspace concurrent sessions). */
  workspaceId?: string
  /** Running sum of billing tokens (input+output) across all turns — used for cost tracking. */
  tokenUsage: number
  /** Running sum of input tokens (excludes cache read/creation). */
  inputTokens?: number
  /** Running sum of output tokens. */
  outputTokens?: number
  /**
   * Live SDK context window consumption (from query.getContextUsage().totalTokens).
   * This reflects the actual context size the model sees, unlike tokenUsage which is
   * a cumulative billing total. Only populated for the chat agent when SDK is active.
   */
  contextTokens?: number
  // Complexity scoring — populated when running as a specialist
  model?: ModelTier
  complexityTier?: ComplexityTier
  // Active MCP tool servers — populated by the chat agent to indicate which intelligence tools are enabled
  activeMcpTools?: string[]
}

// ── Multi-Workspace Permission Types ──

export type PermissionType = 'elicitation' | 'askQuestion' | 'mpaApproval'

export interface PendingPermission {
  id: string
  workspaceId: string
  workspaceName: string
  type: PermissionType
  summary: string
  /** Whether the permission can be resolved inline (approve/deny) vs needing full context */
  isSimple: boolean
  payload: unknown
  receivedAt: number
  /** True after toast timeout — indicates permission should show as sidebar badge instead */
  badgeFallback?: boolean
}

export interface PermissionResponse {
  permissionId: string
  workspaceId: string
  type: PermissionType
  response: 'approve' | 'deny' | { answer: string } | { approved: boolean; feedback?: string }
}

export interface CompletionNotification {
  workspaceId: string
  workspaceName: string
  service: 'chat' | 'grill' | 'audit' | 'mpa' | 'blueprint' | 'council'
  status: 'completed' | 'failed' | 'needs_input'
  summary: string
  /** Target page for click-to-navigate from OS notification */
  targetPage?: 'chat' | 'grill' | 'audit' | 'mpa' | 'blueprints' | 'council'
  /** Entity ID for deep navigation (blueprintId, sessionId, etc.) */
  entityId?: string
}

// ── Tool Activity ──
export type ToolOperationType =
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'shell'
  | 'codegraph'
  | 'other'

export interface ToolActivity {
  id: string
  toolName: string
  status: 'running' | 'completed' | 'error'
  input?: string
  result?: string
  /** Extended result for expand panel — first ~2K chars of raw tool output */
  resultDetail?: string
  startedAt: number
  completedAt?: number
  /** Updated by tool_progress events — elapsed time in seconds */
  elapsedSeconds?: number
  /** Workspace-relative file path (e.g., "src/main/app.ts") */
  filePath?: string
  /** Line range (e.g., "42-56") */
  lineRange?: string
  /** Operation classification */
  operationType?: ToolOperationType
}

// ── Specialist & Skill Models ──
export interface Specialist {
  id: string
  agentId: string
  displayName: string
  /** Agent description — from YAML description field, stored in DB */
  description: string
  icon: string
  color: string
  prompt: string
  priority: number
  isActive: boolean
  sourceYaml: string | null
  alias: string | null
  avatarUrl: string | null
  isCore: boolean
  skills?: Skill[]
  createdAt: string
  updatedAt: string
}

export interface Skill {
  id: string
  name: string
  description: string
  filename: string
  filePath: string
  isActive: boolean
  lastUpdatedDate: string | null
  createdAt: string
  updatedAt: string
  /** Pre-computed semantic summary for full budget tier (~2000 chars) */
  summaryFull: string | null
  /** Pre-computed semantic summary for standard budget tier (~800 chars) */
  summaryStandard: string | null
  /** Pre-computed semantic summary for minimal budget tier (~200 chars) */
  summaryMinimal: string | null
  /** SHA-256 hash of SKILL.md content for staleness detection */
  summaryHash: string | null
  /** Tier 1: JSON metadata — name, description, activation keywords (~50 tokens) */
  tier1Json: string | null
  /** Tier 2: Core instructions extracted from first section (~500 tokens) */
  tier2Instructions: string | null
  /** Haiku-generated enrichment metadata (keywords, applicableTo, complexity) */
  enrichmentJson: string | null
}

export interface CreateSpecialistInput {
  agentId: string
  displayName: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  isActive?: boolean
}

export interface UpdateSpecialistInput {
  displayName?: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  isActive?: boolean
  alias?: string | null
  avatarUrl?: string | null
}

export interface ConversationSpecialist {
  id: string
  conversationId: string
  specialistId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
  // Joined fields for UI convenience
  specialist?: Specialist
}

export interface SpecialistTokenEstimate {
  specialistId: string
  displayName: string
  skillCount: number
  promptTokens: number
  skillTokens: number
  skillBreakdown: { name: string; tokens: number }[]
  estimatedTokens: number
}

export type ChatBubbleSize = 'small' | 'medium' | 'large' | 'xl'

/** Visual theme for the entire application */
export type AppTheme = 'code-atelier' | 'glass' | 'porcelain' | 'developer'

/** GitHub PAT type — classic uses OAuth scopes, fine-grained uses granular permissions */
export type GitHubTokenType = 'classic' | 'fine-grained' | 'unknown'

/** Update source provider */
export type UpdateSourceProvider = 'github' | 'drive'

/** Persisted update configuration */
export interface UpdateConfig {
  source: UpdateSourceProvider
  /** Local folder path containing latest-mac.yml + .zip (Drive source) */
  drivePath: string
  /** GitHub owner — pre-filled, for future GitHub artifact support */
  githubOwner: string
  /** GitHub repo — pre-filled, for future GitHub artifact support */
  githubRepo: string
}

export interface AppPreferences {
  specialistWarningBuild: boolean
  specialistWarningPlan: boolean
  specialistWarningAlways: boolean
  chatBubbleSize: ChatBubbleSize
  appTheme: AppTheme
  updateSource: UpdateSourceProvider
  updateDrivePath: string
  updateGithubOwner: string
  updateGithubRepo: string
  context7ApiKey?: string
  notificationsEnabled: boolean
  /** Max concurrent build tasks within a Blueprint wave (1 = sequential, clamped 1–6). */
  parallelBuildAgents: number
}

// ── Workspace Deploy Models ──

/** Represents a skill directory discovered on the filesystem */
export interface DiscoveredSkill {
  name: string
  dirPath: string
  hasSkillMd: boolean
  referenceFiles: string[]
  frontmatter: {
    name?: string
    description?: string
  } | null
  isActive: boolean
  lastUpdated: string | null
  source: 'master' | 'workspace'
}

/** Represents an agent YAML discovered on the filesystem */
export interface DiscoveredAgent {
  filename: string
  filePath: string
  parsed: {
    name: string
    description: string
    model: string
    tools: string[]
    skills: string[]
  }
  bodyContent: string
  isActive: boolean
  isDeployed: boolean
  source: 'master' | 'workspace'
  specialistId?: string
}

/** Result of scanning a workspace's .claude/ status */
export interface WorkspaceClaudeStatus {
  hasClaudeDir: boolean
  hasClaudeMd: boolean
  hasAgentsDir: boolean
  hasSkillsDir: boolean
  deployedAgents: string[]
  deployedSkills: string[]
  claudeMdPreview: string | null
}

/** Result of the Opus activation flow */
export interface ActivationResult {
  success: boolean
  selectedAgents: string[]
  selectedSkills: string[]
  error?: string
  // CLAUDE.md diff data for user review
  existingClaudeMd: string | null
  proposedClaudeMd: string | null
  claudeMdWritten: boolean
  // Tech-stack detection results
  detectedTechs?: string[]
}

/** Progress event during Opus activation */
export interface ActivationProgressEvent {
  type: 'status' | 'stderr' | 'error'
  message: string
  timestamp: number
}

export interface CompleteResult {
  branch: string
  commitHash: string
  prUrl?: string
}

// ── SDK Terminal Reason (0.2.96+) ──

/**
 * Why a query stopped — from SDK result.terminal_reason.
 * Used for smarter recovery nudge, circuit breaker, and user-facing diagnostics.
 */
export type TerminalReason =
  | 'blocking_limit'
  | 'rapid_refill_breaker'
  | 'prompt_too_long'
  | 'image_error'
  | 'model_error'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'stop_hook_prevented'
  | 'hook_stopped'
  | 'tool_deferred'
  | 'max_turns'
  | 'completed'

// ── Complexity Scoring ──

export interface ComplexityScore {
  filesAffected: number // 0-3
  estimatedLines: number // 0-3
  newDependencies: number // 0-2
  taskType: number // 0-3
  riskFlags: number // 0-3
  total: number // 0-14
  tier: 'simple' | 'moderate' | 'complex'
  model: 'haiku' | 'sonnet' | 'opus'
}

export type CostPreference = 'economy' | 'balanced' | 'power'

/** Budget tier controls how much context is included in system prompts (Strategy 4) */
export type BudgetTier = 'minimal' | 'standard' | 'full'

export type ComplexityTier = ComplexityScore['tier']

export type ModelTier = ComplexityScore['model']

/** Actions that consume a Claude model — each can be independently configured */
export type ModelAction =
  | 'specialist'
  | 'specialist:plan'
  | 'specialist:build'
  | 'specialist:simple'
  | 'specialist:moderate'
  | 'specialist:complex'
  | 'memoryFeed'
  | 'activation'
  | 'haiku'
  | 'audit'
  | 'grill'
  | 'council-member'
  | 'council-chairman'
  | 'grill:plan'
  | 'mpa:decompose'
  | 'blueprint:specify'
  | 'blueprint:clarify'
  | 'blueprint:plan'
  | 'blueprint:tasks'
  | 'blueprint:review'
  | 'blueprint:build'
  | 'blueprint:verify'
  | 'prompt:optimize'
  // ── Background one-shot actions ──
  | 'commit-message'
  | 'condense'

/** Per-action model overrides stored in workspace settings_json */
export interface ModelOverrides {
  [key: string]: string // ModelAction → model ID string
}

// ── Model Roles (cross-provider routing) ──

/** A single model assignment for a role — identifies both provider and model. */
export interface ModelRoleAssignment {
  provider: LLMProvider
  modelId: string
  localBackend?: LocalLLMBackend
}

/**
 * Per-action model role map. Each ModelAction can independently point at
 * a different provider+model. Stored in workspace settings_json.modelRoles.
 *
 * This enables "plan with Opus, build with Sonnet, background on local" or
 * "plan with Fable, build with GEMMA" cross-provider routing.
 */
export type ModelRoleMap = Partial<Record<ModelAction, ModelRoleAssignment>>

/**
 * Fully resolved model assignment — the output of resolveAssignment().
 * Includes provenance so consumers know where the assignment came from.
 */
export interface ResolvedAssignment {
  /** The LLM provider for this assignment */
  provider: LLMProvider
  /** The model ID within the provider */
  modelId: string
  /** For local providers, which backend (omlx, ollama) */
  localBackend?: LocalLLMBackend
  /** Where the assignment was resolved from — for debugging & UI display */
  source: 'roles' | 'override' | 'default' | 'fallback'
}

/** Logical grouping of ModelActions for the model role assignment UI */
export interface ActionGroup {
  id: string
  label: string
  icon: string
  description: string
  providerConstrained?: boolean
  advanced?: boolean
  actions: ModelAction[]
}

// ── YAML ↔ DB Sync Models ──

export interface SyncDiff {
  // Specialists
  newSpecialists: DiscoveredAgent[]
  updatedSpecialists: {
    agent: DiscoveredAgent
    dbRecord: Specialist
    changes: string[]
  }[]
  removedSpecialists: Specialist[]
  unchangedSpecialists: Specialist[]

  // Skills
  newSkills: DiscoveredSkill[]
  removedSkills: Skill[]
  unchangedSkills: Skill[]

  // Summary
  hasChanges: boolean
}

export interface SyncResult {
  imported: number
  updated: number
  deactivated: number
  skillsImported: number
  errors: string[]
}

// ── Grill Session Types ──
export interface GrillProposedTask {
  title: string
  description: string
}

export interface GrillQuestionOption {
  label: string
  description?: string
  recommended?: boolean
  /** Rationale for why this option is recommended — e.g. "Lower risk, same outcome; refactor in phase 2" */
  recommendedReason?: string
}

export interface GrillQuestion {
  id: string
  question: string
  header?: string
  options: GrillQuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

export interface GrillAnswerPayload {
  questionId: string
  selectedOptions: string[]
  otherText?: string
  skipped: boolean
}

export type GrillTrackId =
  | 'requirements'
  | 'architecture'
  | 'ux-ui'
  | 'security'
  | 'testing'
  | 'infrastructure'
  | 'data'
  | 'code-quality'

export interface GrillTrack {
  id: GrillTrackId
  name: string
  icon: string
  description: string
  scoringFocus: string[]
}

export interface GrillTrackScore {
  trackId: GrillTrackId
  score: number
  scoreLabel: string
  iterationCount: number
  lastFeedback: string
}

export interface GrillEvaluation {
  trackId?: GrillTrackId
  score: number
  scoreLabel: string
  feedback: string
  questions: GrillQuestion[]
  suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
}

/** A single Q→A decision captured during the greenfield project wizard grill */
export interface GrillDecision {
  trackId: GrillTrackId
  questionId: string
  questionText: string
  selectedOption: string
  otherText?: string
}

/** A single Q→A decision captured during a Grill session */
export interface DecisionEntry {
  iteration: number
  trackId?: GrillTrackId
  question: string
  /** Full question text (2-3 sentences) when different from header */
  questionFull?: string
  answer: string
  /** Score at the iteration this decision belongs to */
  score?: number
}

// ── Structured Plan Types ──
export interface PlanStep {
  number: number
  title: string
  description: string
  icon?: string
  file?: string
  complexity?: 'low' | 'medium' | 'high'
}

export interface PlanSection {
  heading: string
  icon?: string
  content: string
  mermaid?: string
}

export type PlanType = 'bug' | 'feature' | 'refactor' | 'audit' | 'investigation'
export type PhaseRisk = 'low' | 'medium' | 'high'

export interface PlanRootCause {
  id: number
  title: string
  description: string
  /** Which user-visible symptom this root cause explains */
  symptom?: string
}

export interface PlanPhase {
  id: number
  title: string
  /** Complexity score 1-10 */
  complexity: number
  fileCount?: number
  risk: PhaseRisk
  description: string
  files?: Array<{ file: string; change: string }>
}

export interface StructuredPlan {
  /** Plan classification — drives card layout and section ordering */
  type?: PlanType

  title: string
  summary: string

  // ── Diagnostic fields (bugs / investigations) ──
  problemSummary?: string
  rootCause?: string
  decisions?: Array<{ what: string; why: string }>

  /** Multi-root-cause analysis — numbered causes mapped to user symptoms */
  rootCauses?: PlanRootCause[]

  /** Post-implementation verification / acceptance criteria */
  verification?: string[]

  // ── Phased breakdown (features / refactors / audits) ──
  /** Phased plan with complexity scoring and risk levels */
  phases?: PlanPhase[]

  /** Description of the current state / problem being solved */
  currentState?: string

  /** Recommended phase execution order (list of phase IDs) */
  implementationOrder?: number[]

  // ── Existing fields (unchanged) ──
  sections?: PlanSection[]
  steps?: PlanStep[]
  files?: string[]
  filesChanged?: Array<{ file: string; change: string }>
  risks?: Array<{
    risk: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    mitigation?: string
  }>
  expectedOutcome?: string
  deferredItems?: string[]
  diagrams?: Array<{ title: string; mermaid: string }>
  /** Architectural constraints from grill decisions (PLAN-GEN-05) */
  constraints?: string[]
}

export interface PlanDetectedEvent {
  rawContent: string
  structuredPlan: StructuredPlan | null
  beforePlan: string
  afterPlan: string
}

// ── Intent System ──

/**
 * Tracks which control-actions MCP tools fired during the current turn.
 * Used by IntentDetector to prioritize MCP-based detection over regex fallback.
 */
export interface ControlToolState {
  plan: boolean
  askUser: boolean
  /** MCP-emitted plan intent (set by onPlan callback) */
  planIntent?: AgentIntent & { type: 'plan' }
  /** MCP-emitted askUser intent (set by onAskUser callback) */
  askUserIntent?: AgentIntent & { type: 'askUser' }
}

/**
 * The chat agent's decision after processing a user message.
 *
 * Discriminated union that collapses the previously fragmented event system
 * (5 string-based emit() calls, 3 detect*() methods, 3 MCP callbacks) into
 * a single typed output. Each variant maps to one UI action.
 *
 * Emitted by specialist
 * adapters via AgentSessionService.
 */
export type AgentIntent =
  | { type: 'response'; content: string }
  | { type: 'plan'; plan: PlanDetectedEvent }
  | { type: 'askUser'; questions: GrillQuestion[]; action?: string; requestId?: string }
  | { type: 'grillQuestion'; questions: GrillQuestion[] }
  | {
      type: 'grillComplete'
      summary: string
      proposedTasks: Array<{ title: string; description: string }>
    }
  | { type: 'grillEvaluation'; evaluation: GrillEvaluation }
  | { type: 'error'; message: string }

// ── Build Summary Type ──
export interface BuildSummary {
  tasks: Array<{
    taskId: string
    specialist: string
    description: string
    status: 'completed' | 'failed' | 'skipped'
    filesChanged?: string[]
    error?: string
    duration?: number
  }>
  totalDuration: number
  mode: ConversationMode
  deferredItems?: string[]
  recommendations?: string[]
}

// ── Agent Session & Token Tracking ──
export interface AgentSessionRecord {
  id: string
  taskId: string | null
  agentType: string
  pid: number | null
  status: 'running' | 'completed' | 'failed' | 'terminated'
  startedAt: string
  endedAt: string | null
  tokenUsage: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  conversationId: string | null
  workspaceId: string | null
}

export interface TokenSummary {
  totalTokens: number
  sessionCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  /** Sum of SDK-reported context window sizes across all turns */
  totalContextTokens: number
  /** Number of recorded turns from turn_usage table */
  totalTurns: number
  byAgent: { agentType: string; totalTokens: number; sessionCount: number }[]
}

/** Per-feature usage row in the unified usage_log breakdown. */
export interface FeatureUsageSummary {
  feature: string
  tokens: number
  costCents: number
  calls: number
}

/** Unified usage_log summary (all token consumption, broken down by feature). */
export interface WorkspaceUsageSummary {
  totalTokens: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalCostCents: number
  byFeature: FeatureUsageSummary[]
}

// ── Knowledge-Aware Memory Engine ──

/** Category of a stored fact. */
export type MemoryFactCategory = 'decision' | 'convention' | 'gotcha' | 'preference' | 'reference'

/** Confidence/maturity tier: T0 observed → T3 wisdom. */
export type MemoryFactTier = 0 | 1 | 2 | 3

/** Lifecycle status — superseded facts are never deleted. */
export type MemoryFactStatus = 'active' | 'superseded' | 'archived'

/** How the fact was originally captured. */
export type MemorySourceType = 'session' | 'commit' | 'document' | 'tool' | 'manual' | 'claude-md' | 'blueprint' | 'grill'

export interface MemoryFact {
  id: string
  workspaceId: string | null // null = global user preference / correction
  category: MemoryFactCategory
  title: string
  content: string
  tags: string[]
  scopePaths: string[] // file/dir paths this fact is relevant to
  tier: MemoryFactTier
  confidence: number // 0.0 – 1.0
  confirmationCount: number
  lastConfirmedAt: string | null
  status: MemoryFactStatus
  supersededBy: string | null // id of the fact that superseded this one
  mergedInto: string | null // id of canonical fact after cluster merge
  volatile: boolean // version/count facts: always UPDATE-in-place, never promoted past T1
  sourceType: MemorySourceType
  sourceRef: string | null // conversation id / commit sha / doc path
  embeddingPending: boolean
  lastAccessedAt: string | null
  createdAt: string
  updatedAt: string
  /** Count of non-auto_dedup confirmations (real evidence). Populated by UI-facing queries only. */
  evidenceCount?: number
}

/** Resolution status for a contradiction between two facts. */
export type ContradictionStatus = 'auto_resolved' | 'pending' | 'user_resolved'

export interface MemoryContradiction {
  id: string
  oldFactId: string
  newFactId: string
  status: ContradictionStatus
  resolution: string | null // human-readable explanation
  createdAt: string
  resolvedAt: string | null
}

/** How a confirmation was earned. */
export type ConfirmationSourceType = 'auto_dedup' | 'human' | 'tool' | 'extraction' | 'bootstrap'

/** Individual confirmation event (replaces bare counter for evidence-based promotion). */
export interface MemoryConfirmation {
  id: string
  factId: string
  sourceType: ConfirmationSourceType
  weight: number // auto_dedup = 0.0, human/tool/extraction = 1.0
  createdAt: string
}

/** Classifier action for the Mem0-style write path. */
export type MemoryClassifierAction = 'ADD' | 'UPDATE' | 'NOOP' | 'SUPERSEDE'

/** Doc-watcher gate: tracks content hashes to avoid re-extracting unchanged docs. */
export interface MemoryDocState {
  workspaceId: string
  filePath: string
  contentHash: string
  lastExtractedAt: string
}

/** Progress event for memory extraction (session-end, commit, doc feed). */
export interface MemoryFeedProgress {
  status: 'running' | 'done' | 'error'
  message: string
  source: MemorySourceType
  timestamp?: number
}

/** Capture settings stored per workspace (persisted in workspace settings_json). */
export interface MemoryCaptureSettings {
  sessionCapture: boolean
  commitCapture: boolean
  docCapture: boolean
  captureBlueprints: boolean
  captureGrill: boolean
  captureDocumentsOnAttach: boolean
  watcherGlobs: string[]
}

/** Bootstrap mode for project knowledge generation. */
export type BootstrapMode = 'full' | 'incremental' | 'deep-scan'

/** Phase labels for bootstrap progress. */
export type BootstrapPhaseLabel =
  | 'preflight'
  | 'docs'
  | 'stack'
  | 'architecture'
  | 'history'
  | 'structure'
  | 'agent-exploration'
  | 'finalize'

/** Progress event for project knowledge bootstrap. */
export interface BootstrapProgress {
  jobId: string
  /** Current phase (0-based index) */
  phaseIndex: number
  /** Total phases in this run */
  phaseCount: number
  /** Human-readable phase label */
  phaseLabel: BootstrapPhaseLabel
  /** Number of facts created so far across all phases */
  factsCreated: number
  /** Message for display */
  message: string
  /** Overall job status */
  jobStatus: 'running' | 'done' | 'cancelled' | 'error'
  /** Bootstrap mode */
  mode: BootstrapMode
}

/** Progress event for document ingestion jobs. */
export interface IngestionProgress {
  jobId: string
  /** Current document index (1-based) */
  docIndex: number
  /** Total documents in the job */
  docCount: number
  /** Current chunk index within the current doc (1-based), 0 if not chunking yet */
  chunkIndex: number
  /** Total chunks for current doc, 0 if not chunking yet */
  chunkCount: number
  /** Number of facts created so far across all docs */
  factsCreated: number
  /** Per-document status */
  docStatus: 'queued' | 'reading' | 'chunking' | 'extracting' | 'done' | 'skipped' | 'error'
  /** Current document file name */
  docName: string
  /** Message for display */
  message: string
  /** Overall job status */
  jobStatus: 'running' | 'done' | 'cancelled' | 'error'
}

/** Result of a hybrid retrieval query. */
export interface MemoryRetrievalResult {
  fact: MemoryFact
  score: number // combined relevance score
  matchType: 'cosine' | 'keyword' | 'hybrid'
}

/** Embedding status summary for the UI banner. */
export interface MemoryEmbeddingStatus {
  isReady: boolean
  pendingCount: number
  totalCount: number
  modelName: string | null
}

// ── Knowledge Graph View ──

export type MemoryGraphEdgeKind = 'similarity' | 'superseded' | 'contradiction'

export interface MemoryGraphNode {
  id: string
  title: string
  category: MemoryFactCategory
  tier: MemoryFactTier
  status: MemoryFactStatus
  confidence: number
}

export interface MemoryGraphEdge {
  source: string
  target: string
  kind: MemoryGraphEdgeKind
  weight: number // 0–1 for similarity, 1.0 for structural edges
}

export interface MemoryGraphData {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
}

// ── Legacy types kept for backward compat during transition ──
// TODO: Remove after Phase 6 cleanup
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface Memory {
  id: string
  workspaceId: string | null
  type: MemoryType
  title: string
  content: string
  tags: string[]
  sourceConversationId: string | null
  sourceAgentId: string | null
  importance: number
  lastAccessedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceFeedTimestamps {
  'claude-md'?: string
  codebase?: string
  document?: string
}

export interface MemoryFeedResult {
  success: boolean
  source: 'claude-md' | 'codebase' | 'document'
  memoriesCreated: number
  error?: string
}

/** Structured investigation report produced by specialist in plan mode */
export interface InvestigationReport {
  problem: string
  rootCause: string
  proposedFix: string
  filesAffected: Array<{ path: string; reason: string }>
  impact: 'very-low' | 'low' | 'medium' | 'high' | 'critical'
  impactReason: string
}

// ── Image Attachments ──
export interface ImageAttachment {
  base64: string
  mimeType: string
  fileName: string
}

// ── Ideas ──
export interface Idea {
  id: string
  workspaceId: string
  title: string
  description: string
  status: 'draft' | 'grilling' | 'completed'
  grillConversationId?: string
  grillSummary?: string
  convertedConversationId?: string
  grillDecisions?: string
  createdAt: string
  updatedAt: string
}

/** A document file discovered in the workspace /docs folder */
export interface DocFile {
  /** File name (e.g. "auto-update-flow.md") */
  name: string
  /** Absolute file path */
  path: string
  /** File extension without dot (e.g. "md", "docx", "pdf") */
  extension: string
  /** Whether the format is renderable (only .md for now) */
  supported: boolean
  /** File size in bytes */
  sizeBytes: number
  /** Last modified timestamp (epoch ms) */
  modifiedAt: number
}

export interface RepoInfo {
  isRepo: boolean
  hasRemote: boolean
  remoteUrl?: string
  currentBranch: string
}

// ── AI Subscriptions ──
export interface SubscriptionCheckResult {
  claudeCli: { installed: boolean; version: string | null; error: string | null }
  claudeAuth: { authenticated: boolean; accountEmail: string | null; error: string | null }
  claudeMax: { active: boolean; plan: string | null; error: string | null }
  codexCli: { installed: boolean; version: string | null; error: string | null }
  sdkHealth?: {
    sdkVersion: string | null
    modelsAvailable: string[]
    opus48Available: boolean
    error: string | null
  }
}

export interface AutoConfigureResult {
  success: boolean
  error: string | null
}

// ── Embedding Provider ──

/** Which embedding backend is active. oMLX is the only supported backend. */
export type EmbeddingBackend = 'omlx'

/** Status of the oMLX embedding backend */
export interface EmbeddingModelStatus {
  /** oMLX is running and an embedding model is loaded + responding */
  ready: boolean
  backend: 'omlx'
  /** oMLX server is reachable */
  omlxRunning: boolean
  /** oMLX is installed on this machine (even if not running) */
  omlxInstalled: boolean
  /** ID of the loaded embedding model (e.g. 'bge-m3') or null if none */
  omlxEmbeddingModelId: string | null
  /** Whether the embedding model is loaded in oMLX memory */
  omlxEmbeddingModelLoaded: boolean
  /** All models from oMLX (embedding + LLM). Renderer can display this list. */
  omlxAllModels?: OmlxModelDetail[]
  /** False when admin API was unreachable (auth/timeout) — models inferred from /v1/models */
  omlxAdminApiAvailable: boolean
}

// ── Ollama ──
export interface OllamaStatus {
  installed: boolean
  running: boolean
  version?: string
  models: string[]
}

/** oMLX admin API model detail — richer than /v1/models */
export interface OmlxModelDetail {
  id: string
  loaded: boolean
  isLoading: boolean
  estimatedSize: string // e.g. "19.02 GB"
  pinned: boolean
  isDefault: boolean
  modelType: string // "llm", "vlm", "embedding", "reranker"
}

/** Extended status returned when oMLX admin API is available */
export interface OmlxExtendedStatus extends OllamaStatus {
  /** All models (downloaded + loaded) from admin API. Undefined when admin API unavailable. */
  allModels?: OmlxModelDetail[]
  /** Connection diagnostics — populated when something went wrong */
  diagnostics?: {
    /** Admin API returned 401 — API key is missing or wrong */
    adminAuthRequired: boolean
    /** Admin API HTTP status code (401, 404, 500, etc.) */
    adminHttpStatus?: number
    /** Connection timed out (AbortError) rather than refused */
    timedOut: boolean
    /** Specific error message for UI display */
    errorDetail?: string
  }
}

export interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  percent: number
}

// ── Code Graph (persisted repomap) ──
export interface CodeGraphIndexingState {
  workspaceId: string
  status: 'idle' | 'scanning' | 'parsing' | 'ranking' | 'persisting' | 'complete' | 'error'
  totalFiles: number
  processedFiles: number
  totalTags: number
  totalEdges: number
  currentFile: string
  error?: string
}

// ── Semantic Search / Indexing ──
export interface IndexingState {
  workspaceId?: string
  status:
    | 'idle'
    | 'scanning'
    | 'preprocessing'
    | 'indexing-files'
    | 'indexing-chunks'
    | 'embedding'
    | 'enriching'
    | 'paused'
    | 'complete'
    | 'error'
  totalFiles: number
  processedFiles: number
  totalChunks: number
  processedChunks: number
  preprocessTotal: number
  preprocessComplete: number
  preprocessSkipped: number
  descriptionsGenerated: number
  descriptionsCached: number
  descriptionsTotal: number
  descriptionsProcessed: number
  /** Description source for the current run: 'heuristic' | 'ai' | 'none' */
  descriptionSource?: 'heuristic' | 'ai' | 'none'
  /** Estimated time remaining in human-readable form */
  estimatedRemaining?: string
  currentFile?: string
  error?: string
}

export interface SemanticSearchResult {
  filePath: string
  symbolName: string
  body: string
  score: number
  metadata: Record<string, unknown>
}

// ── Elicitation (MCP server user input requests) ──

/** Bug Tracker record — shared between main and renderer */
export interface BugRecord {
  id: string
  fingerprint: string
  timestamp: string
  lastSeenAt: string
  process: 'main' | 'renderer' | 'preload'
  severity: 'error' | 'fatal'
  errorMessage: string
  stackTrace: string | null
  sourceFile: string | null
  sourceLine: number | null
  sourceColumn: number | null
  componentName: string | null
  activeView: string | null
  workspaceId: string | null
  agentId: string | null
  appVersion: string
  osInfo: string | null
  isResolved: boolean
  occurrenceCount: number
  note: string | null
  createdAt: string
}

/** Elicitation request emitted to the renderer when an MCP server requests user input */
export interface ElicitationEvent {
  serverName: string
  message: string
  mode: 'form' | 'url'
  requestedSchema?: Record<string, unknown>
  url?: string
  elicitationId?: string
}

// ── Local LLM Provider ──

/** LLM provider for a workspace */
export type LLMProvider = 'claude' | 'local-llm'

/** Local LLM inference backend */
export type LocalLLMBackend = 'ollama' | 'omlx'

/** Local LLM execution strategy */
export type LocalLLMStrategy = 'default' | 'native'

/**
 * Executor backend — which runtime drives AI interactions.
 * - 'cli' — Interactive Claude CLI (stream-json mode) — subscription billing
 * - 'opencode' — OpenCode multi-provider runtime (@opencode-ai/sdk)
 *
 * Stored in workspace settings_json.executorBackend. Default: 'cli'.
 *
 * - 'cli' — Claude CLI (claude -p mode)
 * - 'opencode' — OpenCode multi-provider runtime
 * - 'codex' — OpenAI Codex CLI (codex exec mode)
 */
export type ExecutorBackend = 'cli' | 'opencode' | 'codex'

/**
 * Typed workspace settings — single source of truth for keys stored in
 * `workspaces.settings_json`. All fields are optional because settings
 * are accumulated incrementally as the user configures things.
 */
export interface WorkspaceSettings {
  // ── Executor / Provider ──
  executorBackend?: ExecutorBackend
  llmProvider?: LLMProvider
  costPreference?: CostPreference
  communicationTone?: CommunicationTone

  // ── Budget ──
  budgetCapUsd?: number
  sessionBudgetUsd?: number
  dailyBudgetUsd?: number

  // ── Context / Compaction ──
  localContextWindow?: number
  autoCompactEnabled?: boolean
  compactSuggestThreshold?: number
  compactAutoThreshold?: number
  contextPrimingEnabled?: boolean

  // ── Feature Flags ──
  promptOptimizationEnabled?: boolean
  enableCodeGraph?: boolean
  enableSemanticSearch?: boolean
  enableGitContext?: boolean
  repomapEnabled?: boolean
  semanticSearchEnabled?: boolean
  semanticSearchDescriptions?: boolean
  memoryEnabled?: boolean
  localMcpActive?: boolean
  gitAutoBranch?: boolean
  /** Show Ollama provider option in Settings (default false) */
  showOllamaProvider?: boolean

  // ── Local LLM ──
  descriptionModel?: string

  // ── OpenCode ──
  openCodeProvider?: string
  openCodeModel?: string
  openCodeBaseUrl?: string
  openCodeApiKey?: string

  // ── GitHub ──
  githubTokenEncrypted?: string
  githubToken?: string
  githubLogin?: string
  githubTokenType?: string

  // ── Misc ──
  additionalDirectories?: string[]
  modelOverrides?: Record<string, unknown>

  /** Catch-all for forward-compatibility */
  [key: string]: unknown
}

/** Configuration for local LLM provider */
export interface LocalLLMConfig {
  provider: LLMProvider
  backend: LocalLLMBackend
  localModel: string // was: ollamaModel
  localHost: string // was: ollamaHost — e.g. '127.0.0.1' or '192.168.1.50'
  localPort: number // was: ollamaPort — e.g. 11434 (Ollama) or 8000 (oMLX)
  strategy?: LocalLLMStrategy
  localApiKey?: string // oMLX API key for authenticated instances
}

/** Platform info exposed to the renderer for feature gating */
export interface PlatformInfo {
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64' | string
  /** True when running on macOS Apple Silicon — enables oMLX option */
  isAppleSilicon: boolean
  /** Total system memory in GB (for model recommendations) */
  totalMemoryGB: number
  /** Application version from package.json (via app.getVersion()) */
  appVersion: string
}

// ── Workspace Health Audit ──

export type AuditTrackId =
  | 'database'
  | 'code'
  | 'testing'
  | 'architecture'
  | 'security'
  | 'documentation'
  | 'ui-ux'

export type AuditMode = 'light' | 'deep'
export type AuditRunStatus = 'pending' | 'running' | 'completed' | 'partial' | 'cancelled'
export type AuditorStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AuditTrack {
  id: AuditTrackId
  name: string
  icon: string // Lucide icon name
  description: string
  weight: number // for weighted average (default 1.0)
  scoringFocus: string[] // key areas this auditor evaluates
}

/** A curated, selectable focus area for an auditor in Deep mode. */
export interface AuditSkill {
  id: string
  name: string
  description: string
  icon: string // Lucide icon name
}

/** Per-track selected skill ids (Deep mode). */
export type AuditSelectedSkills = Partial<Record<AuditTrackId, string[]>>

export interface AuditFinding {
  id: string // generated UUID
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  title: string
  description: string
  filePath?: string
  recommendation?: string
}

export interface AuditCoverageStats {
  filesInspected: string[]
  fileCount: number
  toolCallCount: number
  readToolCount: number
}

/**
 * Whether a track's score should count toward the overall score.
 * - 'ok'             — sufficient evidence, score is trustworthy
 * - 'not-applicable' — no files of this track's kind exist in the repo
 * - 'insufficient'   — some files inspected but coverage too low to trust
 */
export type AuditApplicability = 'ok' | 'not-applicable' | 'insufficient'

export interface AuditResult {
  id: string
  auditRunId: string
  trackId: AuditTrackId
  score: number | null // null while pending/running
  status: AuditorStatus
  findings: AuditFinding[]
  summary: string
  skillsUsed: string[] // skill names used (Deep mode)
  startedAt: string | null
  completedAt: string | null
  /** Coverage metadata — tracks what was actually inspected */
  coverageStats?: AuditCoverageStats
  /** Whether the audit had sufficient evidence to trust the score */
  coverageSufficient?: boolean
  /**
   * Whether this track counts toward the overall score. Derived in the audit
   * service from file discovery + coverage gate. Not persisted — recompute via
   * `deriveApplicability` when reading a run back from the DB.
   */
  applicability?: AuditApplicability
  /** Runtime-only: multi-round progress (not persisted to DB) */
  roundProgress?: {
    roundNumber: number
    totalRounds: number
    totalFiles: number
    batchSize: number
  }
}

export interface AuditRun {
  id: string
  workspaceId: string
  mode: AuditMode
  status: AuditRunStatus
  overallScore: number | null
  selectedTracks: AuditTrackId[]
  detectedTechs: string[]
  /** Per-track skills the user selected for this run (Deep mode). Execution deferred. */
  selectedSkills?: AuditSelectedSkills
  results: AuditResult[] // joined for UI convenience
  createdAt: string
  updatedAt: string
}

/**
 * Structured remediation plan synthesized from selected audit findings.
 * Modeled on GrillStructuredPlan. `requirementDocument` is the markdown handed
 * off when routing to Chat / Grill / Goals / Council / Export.
 */
export interface AuditPlan {
  version: 1
  title: string
  summary: string
  items: Array<{
    id: string
    title: string
    description: string
    scope: 'backend' | 'frontend' | 'database' | 'shared' | 'tests'
    severity?: 'info' | 'low' | 'medium' | 'high' | 'critical'
    files: string[]
    recommendation: string
    dependsOn?: string[]
  }>
  risks: string[]
  sourceFindingIds: string[]
  requirementDocument: string
}

/** A persisted audit plan with its DB identity. */
export interface AuditPlanRecord {
  id: string
  auditRunId: string
  title: string
  summary: string
  plan: AuditPlan
  sourceFindingIds: string[]
  createdAt: string
}

export interface AuditProgressEvent {
  workspaceId: string
  trackId: AuditTrackId
  status: AuditorStatus
  score?: number
  streamChunk?: string // live text from the running auditor
}

/** Intermediate findings event during multi-round audits */
export interface AuditIntermediateEvent {
  workspaceId: string
  trackId: AuditTrackId
  findings: AuditFinding[]
  coverageStats: AuditCoverageStats
  roundNumber: number
  totalRounds: number
  totalFiles: number
  batchSize: number
}

/** Rich streaming event for chat-like audit execution view */
export interface AuditStreamChunkEvent {
  workspaceId: string
  trackId: AuditTrackId
  type: 'text' | 'tool_activity'
  content?: string
  toolActivity?: Partial<ToolActivity> & { id: string; toolName: string }
}

/** Memory tier for hardware-aware model recommendations */
export type MemoryTier = '8gb' | '16gb' | '32gb' | '48gb+'

/**
 * Tool calling quality level for local models.
 * - 'none'      — No tool calling support; analysis/chat only
 * - 'basic'     — Tool calls work but format compliance varies
 * - 'good'      — Reliable tool calls, occasional format issues
 * - 'native'    — Built-in tool calling support, reliable format
 * - 'excellent'  — Best-in-class tool calling, native format compliance
 */
export type ToolCallingQuality = 'none' | 'basic' | 'good' | 'native' | 'excellent'

/** Recommended local model entry */
export interface RecommendedLocalModel {
  /** Model ID for Ollama backend (e.g. 'qwen3-coder:30b') */
  ollamaId: string
  /** Model ID for oMLX backend — HuggingFace format (e.g. 'mlx-community/Qwen3-30B-A3B-4bit'). Omit if model has no MLX variant. */
  omlxId?: string
  label: string
  parameterSize: string
  activeParams?: string
  contextWindow: number
  quantization?: string
  minMemoryGB: number
  memoryTier: MemoryTier
  toolCalling: ToolCallingQuality
  description: string
  recommended?: boolean
  mlxOptimized?: boolean
  /** Notes about tool calling behavior (e.g. format quirks, retry recommendations) */
  toolCallingNotes?: string
  /**
   * Whether the model supports parallel tool calls (multiple tool_use blocks in one response).
   * Models like Qwen3-Coder and DeepSeek-Coder-V3 support this natively.
   */
  supportsParallelTools?: boolean
  /**
   * Whether the model emits <think> blocks for reasoning display.
   * Qwen3 and DeepSeek models typically do this.
   */
  supportsThinking?: boolean
  /**
   * Whether the model has a native vision encoder (VLM).
   * When true, the model can process image_url content parts.
   * Examples: Qwen 3.6 (native VL), Gemma 3 27B.
   */
  supportsVision?: boolean
}

// ── Council Types ──

/** The five council advisor roles — thinking styles with built-in tension */
export type CouncilAdvisorRole =
  | 'contrarian'
  | 'first-principles'
  | 'expansionist'
  | 'outsider'
  | 'executor'

/** Council session lifecycle status */
export type CouncilSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed'

/** What the council is evaluating */
export type CouncilInputType = 'plan' | 'requirement' | 'question'

/** Current phase of the council process */
export type CouncilPhase =
  | 'framing' // Step 1: context enrichment
  | 'deliberating' // Step 2: 5 parallel advisor sessions
  | 'peer-review' // Step 3: anonymous peer review
  | 'synthesizing' // Step 4: chairman synthesis
  | 'complete'
  | 'cancelled'
  | 'failed'

/** Status of an individual council member */
export type CouncilMemberStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Advisor verdict on the input */
export type CouncilAdvisorVerdict = 'proceed-with-changes' | 'needs-revision' | 'rethink'

/** Evidence backing an advisor's finding */
export interface CouncilEvidence {
  file: string
  finding: string
}

/** Structured output from a single council advisor */
export interface CouncilReview {
  advisorRole: CouncilAdvisorRole
  score: number
  verdict: CouncilAdvisorVerdict
  keyFindings: string[]
  blindSpots: string[]
  evidence: CouncilEvidence[]
  summary: string
}

/** Peer review output — each reviewer evaluates anonymized responses */
export interface CouncilPeerReview {
  reviewerRole: CouncilAdvisorRole
  strongestResponse: string // 'A' through 'E'
  strongestReason: string
  biggestBlindSpot: string // 'A' through 'E'
  blindSpotDescription: string
  missedByAll: string
}

/** Priority of a revision recommendation */
export type CouncilRevisionPriority = 'high' | 'medium' | 'low'

/** A single revision recommendation from the chairman */
export interface CouncilRevision {
  priority: CouncilRevisionPriority
  description: string
  consensus: string // e.g. '3/5 advisors'
  evidence: string
}

/** Chairman's synthesized verdict — the final output */
export interface CouncilVerdict {
  overallScore: number
  sections: {
    agrees: string
    clashes: string
    blindSpots: string
    recommendation: string
    oneThingFirst: string
  }
  revisions: CouncilRevision[]
  individualScores: Record<CouncilAdvisorRole, number>
  rankingsMatrix: Record<string, unknown>
}

/** Full council session state */
export interface CouncilSession {
  id: string
  workspaceId: string
  conversationId?: string
  inputType: CouncilInputType
  inputContent: string
  phase: CouncilPhase
  reviews: CouncilReview[]
  peerReviews: CouncilPeerReview[]
  verdict: CouncilVerdict | null
  memberStatuses: Record<CouncilAdvisorRole, CouncilMemberStatus>
  createdAt: string
  completedAt?: string
}

// ── Grill Structured Plan ──────────────────────────────────────────────────

/** Structured plan generated during the grill completion phase */
export interface GrillStructuredPlan {
  /** Version for forward compatibility */
  version: 1
  /** Idea title */
  title: string
  /** Executive summary (2-3 sentences) */
  summary: string
  /** Goal classification */
  goalType: 'feature' | 'refactor' | 'bugfix' | 'tests'
  /** All grill decisions organized by track */
  decisions: Array<{
    trackId: string
    trackName: string
    score: number
    items: Array<{
      question: string
      answer: string
      rationale: string
    }>
  }>
  /** Implementation plan items */
  items: Array<{
    id: string
    title: string
    description: string
    scope: 'backend' | 'frontend' | 'database' | 'shared' | 'tests'
    files: string[]
    dependsOn: string[]
    includesTests: boolean
  }>
  /** Identified risks */
  risks: string[]
  /** Constraints derived from grill decisions */
  constraints: string[]
  /** Original idea description */
  originalDescription: string
  /** Full requirement document (markdown) */
  requirementDocument: string
}

// ── Plan Hub (Unified Plan Registry) ──

export type PlanSource = 'chat' | 'grill' | 'audit' | 'council' | 'mpa' | 'blueprint'
export type PlanStatus = 'saved' | 'handed_off' | 'in_progress' | 'completed' | 'archived'

/** A plan record in the unified plans registry. */
export interface PlanRecord {
  id: string
  workspaceId: string
  source: PlanSource
  sourceId: string
  title: string
  summary: string
  planType: PlanType | null
  structuredPlan: StructuredPlan
  sourcePlanJson: string | null
  requirementDocument: string | null
  status: PlanStatus
  linkedConversationId: string | null
  linkedMpaRunId: string | null
  linkedCouncilSessionId: string | null
  fileCount: number
  phaseCount: number
  riskCount: number
  createdAt: string
  updatedAt: string
  previousPlanId: string | null
}

/** A single entry in a plan's status timeline. */
export interface PlanStatusHistoryEntry {
  id: string
  planId: string
  fromStatus: PlanStatus | null
  toStatus: PlanStatus
  changedAt: string
  actor: string // 'user' | 'system'
}

export interface PlanFilters {
  status?: PlanStatus | PlanStatus[]
  source?: PlanSource
  search?: string
}

// ── E2E Testing Types ──────────────────────────────────────────────────────

export type E2ECategory =
  | 'chat-core'
  | 'chat-edge'
  | 'commands'
  | 'tools'
  | 'memory'
  | 'planning'
  | 'grill'
  | 'council'
  | 'blueprints'
  | 'mpa'
  | 'audit'
  | 'code-intel'
  | 'checkpoints'
  | 'ideas'
  | 'specialists'
  | 'security'
  | 'workspace-ops'

export type E2EScenarioStatus = 'implemented' | 'planned'

/** String key identifying a service-level runner (scenarios that bypass chat and call services directly) */
export type E2EServiceRunnerKey =
  | 'blueprint-create'
  | 'blueprint-phase-management'
  | 'blueprint-progress-tracking'
  | 'blueprint-task-execution'
  | 'blueprint-clarify-live'
  | 'mpa-preflight'
  | 'mpa-goal-conditions'
  | 'mpa-orchestration'
  | 'mpa-cancellation'
  | 'mpa-campaign-sequential'
  | 'mpa-campaign-pause-retry'
  | 'mpa-campaign-skip'
  | 'mpa-campaign-reconcile'
  | 'code-intel-code-graph-index'
  | 'code-intel-embedding-generation'
  | 'code-intel-semantic-search'
  | 'grill-evaluate'
  | 'grill-multi-track'
  | 'grill-iteration'
  | 'grill-condense-requirement'
  | 'grill-generate-plan'
  | 'audit-start-run'
  | 'audit-findings'
  | 'audit-coverage'
  | 'council-start-session'
  | 'council-advisor-opinions'
  | 'council-synthesis'
  | 'council-structured-output'
  | 'memory-tiers'
  | 'memory-dedup-exact'
  | 'memory-dedup-near'
  | 'memory-ambiguous'
  | 'memory-isolation'
  | 'memory-scope-boost'
  | 'memory-session-dedupe'
  | 'checkpoint-capture'
  | 'checkpoint-restore'
  | 'checkpoint-rewind'
  | 'checkpoint-untracked'
  | 'idea-crud'
  | 'idea-start-grill'
  | 'idea-convert'
  | 'idea-to-blueprint'
  | 'specialist-crud'
  | 'specialist-skills'
  | 'specialist-dispatch'
  | 'specialist-override'
  | 'chat-edge-concurrent'
  | 'chat-edge-rapid-cancel'
  | 'chat-edge-compact-race'
  | 'repo-diff-detection'
  | 'repo-commit'
  | 'repo-commit-message'
  | 'btw-question'
  | 'insights-tokens'
  | 'docs-mermaid'

export type E2EResultStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'error'

export type E2ERunStatus = 'running' | 'completed' | 'cancelled'

export interface E2EAssertionResult {
  name: string
  passed: boolean
  reason?: string
}

export interface E2EScenarioSummary {
  id: string
  category: E2ECategory
  title: string
  description: string
  status: E2EScenarioStatus
  mode: 'plan' | 'build'
  timeoutMs: number
  promptCount: number
  /** Service-level runner key (undefined for chat-based scenarios) */
  runner?: E2EServiceRunnerKey
  /** When true, excluded from Run All (heavy/long-running) */
  heavy: boolean
  /** Set when the scenario has a known upstream blocker (failures downgrade to skipped) */
  knownIssue?: string
  /** Set when the scenario's assertions are known-weak — surfaced as a revisit badge */
  falsePositiveRisk?: string
}

export interface E2ERunSummary {
  id: string
  workspaceId: string
  status: E2ERunStatus
  modelId: string | null
  backend: string | null
  startedAt: string
  finishedAt: string | null
  totalPassed: number
  totalFailed: number
  totalSkipped: number
  totalError: number
}

export interface E2EResultSummary {
  id: string
  runId: string
  scenarioId: string
  status: E2EResultStatus
  durationMs: number | null
  failureReason: string | null
  conversationId: string | null
  createdAt: string
}

export interface E2EResultDetail extends E2EResultSummary {
  assertionResults: E2EAssertionResult[]
  transcriptJson: E2ETranscriptEntry[]
}

export interface E2ETranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'status'
  content?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  timestamp: number
}

export interface E2EPreflightResult {
  ok: boolean
  modelId?: string
  error?: string
  /** Whether the model/backend actually emits structured tool_calls */
  supportsTools?: boolean
  /** Whether the model supports image_url content parts (VLM). Text-only models → false. */
  supportsVision?: boolean
}

export interface E2EProgressEvent {
  runId: string
  scenarioId: string
  status: E2EResultStatus
  counts: {
    passed: number
    failed: number
    skipped: number
    error: number
    queued: number
    running: number
    total: number
  }
}

/** Framed input passed to all council members */
export interface CouncilFramedInput {
  planContent: string
  structuredPlan: StructuredPlan | null
  originalUserRequest: string
  workspaceContext: string
  filesInScope: string[]
  inputType: CouncilInputType
}

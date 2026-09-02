// ── Data Models ──
export type ConversationMode = 'plan' | 'build' | 'danger'
export type ConversationType = 'chat' | 'blueprint'

/** Thinking effort level — controls reasoning depth (thinking budget + temperature) */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  | 'blueprint-code-review'
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
  /**
   * Set only on shadow rows: the real workspace this row scopes an index for.
   * Shadows back a worktree's own code-graph index and never appear in the UI.
   */
  shadowOfWorkspaceId?: string
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
  /** Git branch the conversation was started from (for PR base branch default) */
  sourceBranch?: string
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
  /** Hidden messages are persisted for context but not shown in the chat UI (auto-send messages). */
  hidden?: boolean
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

export type PermissionType = 'elicitation' | 'askQuestion' | 'mpaApproval' | 'toolPermission'

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
  /** Tool name extracted for structured display (e.g., "Bash", "Read", "Write") */
  toolName?: string
  /** Full structured tool input for detailed rendering */
  toolInput?: Record<string, unknown>
  /** Conversation title for context (e.g., "Implement auth system") */
  conversationTitle?: string
  /** Conversation that raised the request — routes the inline card to the right transcript. */
  conversationId?: string
  /** Conversation mode for context badge */
  mode?: ConversationMode
}

/**
 * How a permission request ended.
 *
 * `cancelled` covers every path where the request can never be answered: the
 * turn finalized, the CLI child died, the user hit Stop, or the app tore the
 * session down. `timedout` is reserved for an auto-deny backstop.
 */
export type PermissionOutcome = 'approved' | 'denied' | 'timedout' | 'cancelled'

/**
 * Main → Renderer: a permission request reached a terminal state.
 *
 * Without this the renderer only ever learns an outcome from its own click, so
 * a request that dies with its turn leaves the modal/toast/card frozen on
 * "waiting for the agent to continue…" forever.
 */
export interface PermissionResolved {
  /** Matches PendingPermission.id (`perm-<requestId>`). */
  permissionId: string
  /** Raw control-actions requestId, for correlation in logs. */
  requestId: string
  workspaceId: string
  conversationId?: string
  outcome: PermissionOutcome
}

export interface PermissionResponse {
  permissionId: string
  workspaceId: string
  type: PermissionType
  response: 'approve' | 'deny' | { answer: string } | { approved: boolean; feedback?: string }
  /** Original payload — included for toolPermission to carry requestId back to IPC handler. */
  payload?: unknown
}

export interface CompletionNotification {
  workspaceId: string
  workspaceName: string
  service: 'chat' | 'grill' | 'audit' | 'mpa' | 'blueprint' | 'council' | 'memory'
  status: 'completed' | 'failed' | 'needs_input'
  summary: string
  /** Target page for click-to-navigate from OS notification */
  targetPage?: 'chat' | 'grill' | 'audit' | 'mpa' | 'blueprints' | 'council' | 'memory'
  /** Entity ID for deep navigation (blueprintId, sessionId, etc.) */
  entityId?: string
}

/** A detached background process spawned by the process-manager MCP server. */
export interface BackgroundProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startedAt: number
  uptimeMs: number
  alive: boolean
  workspaceId: string
  /** True if an auto-resume is armed — the agent will be woken when it exits. */
  watched: boolean
}

/**
 * Result of stopping a background process.
 *
 * `reason: 'untracked'` means the PID was not in any workspace manifest, so no
 * signal was sent — the app only ever signals processes it can prove it spawned.
 */
export interface ProcessStopResult {
  stopped: boolean
  alreadyExited: boolean
  reason?: 'untracked'
}

/** Result of disarming the auto-resume for a background process. */
export interface ProcessCancelWatchResult {
  cancelled: boolean
  reason?: 'untracked'
}

// ── Tool Activity ──
export type ToolOperationType =
  'read' | 'write' | 'edit' | 'search' | 'shell' | 'codegraph' | 'other'

/** A single before/after segment from an Edit / MultiEdit tool call. */
export interface ToolEditDiff {
  oldString: string
  newString: string
  /** True when either string was clipped to the per-string storage cap. */
  truncated?: boolean
}

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
  /** Per-edit before/after segments — Edit/MultiEdit only. */
  editDiffs?: ToolEditDiff[]
  /** Edits dropped to stay within the storage budget. */
  editDiffsOmitted?: number
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

/** User avatar variant — selectable in App Settings > Profile */
export type UserAvatarVariant = '1' | '2' | '3'

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
  /** Drop semantic-search + code-analysis MCP servers from build tasks (saves 2 processes per task). Default: false (full MCP). */
  leanBuildMcp: boolean
  /** User's chosen avatar variant (1=Hooded Artisan, 2=Scholar, 3=Inventor). Default: '1'. */
  userAvatarVariant: UserAvatarVariant
  /** Absolute hard cap for stream lifetime in minutes (clamped 10–120). Default: 30. */
  maxStreamLifetimeMin: number
  /** When true, Blueprint BUILD dispatches tasks by dependsOn DAG readiness instead of wave barriers (default: true). Kill-switch for the classic wave scheduler. */
  dagScheduling: boolean
  /** When true, Blueprint BUILD/VERIFY phases bypass all permission prompts (default: true). */
  blueprintAutoMode: boolean
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
  // ── Blueprint quality layers ──
  /** Layer 3 — cheap per-task peer review. Optional: off unless explicitly bound. */
  | 'blueprint:peer-review'
  /** Layer 3.5 — strong per-task lead review, and fixer of last resort. */
  | 'blueprint:lead-review'
  /** Layer 4 — adversarial whole-diff review phase. Optional: off unless explicitly bound. */
  | 'blueprint:code-review'
  | 'prompt:optimize'
  // ── Background one-shot actions ──
  | 'commit-message'
  | 'pr-description'
  | 'condense'

/** Which section of the routing UI a role row belongs to. */
export type ModelRoleGroup = 'chat' | 'blueprint' | 'quality' | 'council' | 'background'

/**
 * One row of the model-routing catalogue.
 *
 * Shared so the "In Use" panel in main and the routing editor in the renderer
 * enumerate the *same* roles — a role defined in only one of them is either
 * unroutable or invisible.
 */
export interface ModelRoleRowDef {
  group: ModelRoleGroup
  label: string
  description: string
  /** Every action this row assigns together. */
  actions: ModelAction[]
  /** The action read back to display the row's current selection. */
  primaryAction: ModelAction
}

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
  /**
   * Explicit "off" binding for optional roles (`blueprint:peer-review`,
   * `blueprint:code-review`). When true the corresponding layer/phase is
   * skipped entirely rather than run with a fallback model.
   *
   * Stored as a role entry rather than an absent key so that "the user turned
   * this off" is distinguishable from "the user never configured this".
   */
  disabled?: boolean
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
  /**
   * True when the role is bound off (explicitly, or by an optional role having
   * no binding at all). Callers MUST skip the layer instead of using `modelId`.
   */
  disabled?: boolean
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

  /** Clear, measurable completion condition — what "done" looks like.
   *  Used by Claude CLI's /goal command (Haiku stop-hook evaluator)
   *  to enforce autonomous execution until the condition is met. */
  goal?: string

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

/**
 * How the fact was originally captured.
 *
 * MUST stay in sync with the `source_type` CHECK constraint on `memory_facts`
 * (see migration 132). A value present here but missing from the CHECK makes
 * every write of that kind fail at the DB layer — which is exactly how the
 * whole bootstrap pipeline silently produced zero facts.
 * `memory-source-type-guard.test.ts` enforces the match.
 */
export const MEMORY_SOURCE_TYPES = [
  'session',
  'commit',
  'document',
  'tool',
  'manual',
  'claude-md',
  'blueprint',
  'grill',
  'bootstrap'
] as const

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number]

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
  volatile: boolean // version/count facts: always UPDATE-in-place, capped at T0 (VOLATILE_MAX_TIER)
  sourceType: MemorySourceType
  sourceRef: string | null // conversation id / commit sha / doc path
  embeddingPending: boolean
  lastAccessedAt: string | null
  createdAt: string
  updatedAt: string
  /**
   * Bi-temporal validity (migration 136). `valid*` describe when the fact was
   * true of the project; `observedAt`/`recordedAt` describe when we learned it.
   * Null on rows written before the migration backfill ran.
   */
  validFrom: string | null
  /** NULL means the fact is currently true. */
  validTo: string | null
  /** When the source stated it — a commit date, not the ingestion time. */
  observedAt: string | null
  recordedAt: string | null
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

/**
 * How a confirmation was earned.
 * MUST stay in sync with the `source_type` CHECK on `memory_confirmations`.
 */
export const CONFIRMATION_SOURCE_TYPES = [
  'auto_dedup',
  'human',
  'tool',
  'extraction',
  'bootstrap'
] as const

export type ConfirmationSourceType = (typeof CONFIRMATION_SOURCE_TYPES)[number]

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

/**
 * Typed relationship between two facts (migration 137).
 *
 * Direction is always "from acts on to": A supersedes B, A contradicts B,
 * A derived_from B (A was synthesised out of B), A relates_to B.
 */
export const MEMORY_EDGE_TYPES = [
  'derived_from',
  'relates_to',
  'contradicts',
  'supersedes'
] as const

export type MemoryEdgeType = (typeof MEMORY_EDGE_TYPES)[number]

export interface MemoryEdge {
  id: string
  fromId: string
  toId: string
  edgeType: MemoryEdgeType
  confidence: number
  createdAt: string
}

/** Capture settings stored per workspace (persisted in workspace settings_json). */
export interface MemoryCaptureSettings {
  sessionCapture: boolean
  commitCapture: boolean
  docCapture: boolean
  captureBlueprints: boolean
  capturePlans: boolean
  captureGrill: boolean
  captureDocumentsOnAttach: boolean
  /**
   * Mine `// WHY:` / `// NOTE:` / `// HACK:` / `// GOTCHA:` comments and ADR/RFC
   * citations into facts while the code graph indexes. Defaults to OFF — unlike
   * the other sources this one fires on every file change, so it is opt-in.
   */
  captureRationales: boolean
  watcherGlobs: string[]
  /**
   * Extra globs for agent rule files to load into the prompt alongside
   * CLAUDE.md — e.g. `packages/*\/AGENTS.md`. The standard locations
   * (AGENTS.md, .cursor/rules, .github/copilot-instructions.md, .clinerules,
   * .windsurfrules, nested CLAUDE.md) are discovered automatically; this is for
   * layouts that put them somewhere else. Empty by default.
   */
  instructionSources: string[]
  /**
   * Let the idle consolidation pass ask an LLM to synthesise a parent fact from
   * a cluster of similar ones. Opt-in and capped per run: it is the only part
   * of consolidation that spends money, and synthesised facts land in a review
   * queue rather than being promoted unreviewed.
   */
  reflectionEnabled: boolean
  /**
   * Mirror the fact database to `.agentstudio/memory/*.md` after a Feed Brain
   * run, so the result is reviewable in a diff rather than only in the app.
   *
   * Defaults to OFF because it writes files into the user's working tree. Left
   * on unconditionally it produces untracked files with no warning, which then
   * show up in `git status` — and in at least one release PR. Turning it on is
   * a deliberate choice about whether `.agentstudio/` is committed or ignored.
   */
  projectionEnabled: boolean
  /**
   * Documents extracted in parallel during Feed Brain. Each one is a Claude CLI
   * spawn, so raising this is the main throughput lever — and the main way to
   * hit an API rate limit. Range 1–6, default 3.
   */
  bootstrapConcurrency: number
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

/**
 * How much of the workspace a run should re-read.
 *
 * `changed` honours the memory_doc_state hash gate (only new/edited files);
 * the others selectively drop that gate so a phase can be genuinely re-ingested
 * without the all-or-nothing "force" flag that used to wipe every hash.
 */
export type BootstrapScope = 'changed' | 'docs' | 'deep-scan' | 'full'

/** Lifecycle of a durable bootstrap run (memory_bootstrap_runs.status). */
export type BootstrapRunStatus =
  'planning' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

/** Lifecycle of a single queued work item (memory_bootstrap_items.status). */
export type BootstrapItemStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** What a queued item represents — selects the executor that drains it. */
export type BootstrapItemKind =
  'doc' | 'arch-file' | 'manifests' | 'commits' | 'hotspots' | 'cochange' | 'cycles' | 'agent'

/** The item currently being drained, for "what is it doing right now" display. */
export interface BootstrapCurrentItem {
  sourceRef: string
  phase: BootstrapPhaseLabel
  chunkDone: number
  chunkTotal: number
  factsCreated: number
}

/** Per-phase rollup so the stepper can show real done/total counts. */
export interface BootstrapPhaseStats {
  total: number
  done: number
  facts: number
}

/** Progress event for project knowledge bootstrap. */
export interface BootstrapProgress {
  jobId: string
  /** Durable run id (memory_bootstrap_runs.id) — survives app restarts */
  runId: string
  /** Workspace the run belongs to, so background runs can be attributed */
  workspaceId: string
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
  jobStatus: 'planning' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'
  /** Bootstrap mode */
  mode: BootstrapMode
  /** Total queued items — known up front because planning precedes draining */
  itemsTotal: number
  itemsDone: number
  itemsSkipped: number
  itemsFailed: number
  /** Item being processed right now, or null between items */
  currentItem: BootstrapCurrentItem | null
  /** Keyed by BootstrapPhaseLabel */
  perPhase: Record<string, BootstrapPhaseStats>
  /** Estimate from active (non-paused) throughput; null until measurable */
  etaSeconds: number | null
  itemsPerMinute: number | null
}

/** A durable run row plus its per-phase breakdown. */
export interface BootstrapRunSummary {
  id: string
  workspaceId: string
  mode: BootstrapMode
  scope: BootstrapScope
  status: BootstrapRunStatus
  currentPhase: BootstrapPhaseLabel | null
  itemsTotal: number
  itemsDone: number
  itemsSkipped: number
  itemsFailed: number
  factsCreated: number
  activeMs: number
  error: string | null
  createdAt: string
  finishedAt: string | null
  perPhase: Record<string, BootstrapPhaseStats>
}

/** A queued item as rendered in the per-document list. */
export interface BootstrapItemView {
  id: string
  runId: string
  phase: BootstrapPhaseLabel
  kind: BootstrapItemKind
  sourceRef: string
  contentHash: string | null
  priority: number
  chunkTotal: number
  chunkDone: number
  status: BootstrapItemStatus
  factsCreated: number
  error: string | null
  updatedAt: string
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
  /** Every fact regardless of status — the denominator for embedding coverage. */
  totalCount: number
  /** Active facts only — what the Memories list actually shows. */
  activeCount: number
  modelName: string | null
}

// ── Knowledge Graph View ──

export type MemoryGraphEdgeKind = 'similarity' | 'superseded' | 'contradiction' | 'derived'

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

export type DiffComparisonMode = 'uncommitted' | 'branch-vs-target' | 'all-vs-target'

/**
 * Why both sides of a diff came back identical. `unexplained` means git reported
 * differing blobs yet we resolved equal content — an app bug, never a quiet state.
 */
export type DiffIdenticalReason =
  'mode-change' | 'rename-only' | 'empty-file' | 'no-diff-entry' | 'eol-only' | 'unexplained'

export interface FileDiffResult {
  oldContent: string
  newContent: string
  language: string
  /** True when either side was detected as binary. */
  isBinary?: boolean
  /** Non-fatal problem to surface in the UI (e.g. `git show` failed). */
  warning?: string
  /** Short SHA of the resolved comparison base, for labelling. */
  baseSha?: string
  /** Set only when oldContent === newContent — explains why nothing is shown. */
  identicalReason?: DiffIdenticalReason
  /** File-mode transition (e.g. 100644 → 100755) behind a `mode-change` reason. */
  modeChange?: { from: string; to: string }
  /**
   * Line-ending transition (e.g. crlf → lf) detected between the two sides.
   * Set whenever the styles differ — both when that is the *only* difference
   * (`identicalReason: 'eol-only'`) and when real changes remain alongside it,
   * in which case the content was normalized for display.
   */
  eolChange?: { from: string; to: string }
}

// ── AI Subscriptions ──
export interface SubscriptionCheckResult {
  claudeCli: { installed: boolean; version: string | null; error: string | null }
  claudeAuth: { authenticated: boolean; accountEmail: string | null; error: string | null }
  claudeMax: { active: boolean; plan: string | null; error: string | null }
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

/** Which embedding backend is active. Routes through localEmbeddingProvider facade. */
export type EmbeddingBackend = 'omlx' | 'ollama'

/** Status of the embedding backend (oMLX or Ollama) */
export interface EmbeddingModelStatus {
  /** Embedding provider is initialized and ready to embed */
  ready: boolean
  backend: EmbeddingBackend
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
  // ── Ollama fields (populated when backend === 'ollama') ──
  /** Whether Ollama server is reachable */
  ollamaRunning?: boolean
  /** Selected embedding model in Ollama */
  ollamaEmbeddingModel?: string | null
}

/** One resolved chat role — provider + model actually routed to. */
export interface RuntimeRoleAssignment {
  provider: LLMProvider
  modelId: string
}

/**
 * One fully-resolved role for the "In Use" panel.
 *
 * `source` is the part that answers "why is it this model?" — 'roles' means the
 * user chose it, anything else means it fell through to a default they never
 * set and probably don't know about.
 */
export interface RuntimeRoleRow extends RuntimeRoleAssignment {
  action: ModelAction
  group: ModelRoleGroup
  label: string
  source: 'roles' | 'override' | 'default' | 'fallback'
  localBackend?: LocalLLMBackend
  /**
   * False only when a reachable local server was asked and did not list this
   * model. An unreachable server yields true — absence of evidence is not
   * evidence of absence, and flagging every role on a stopped server is noise.
   */
  available: boolean
}

/**
 * What the running app is using *right now*, as opposed to what is persisted
 * in workspace settings. The gap between the two (`drift`) is invisible in a
 * settings-only view and is what makes a saved-but-unapplied config look broken.
 */
export interface ModelsRuntimeStatus {
  embedding: {
    /** Backend the global facade is routing to at this moment */
    activeBackend: EmbeddingBackend
    /** Model the facade currently holds — '' when none */
    activeModelName: string
    /** Facade has completed a successful readiness probe */
    ready: boolean
    /** Backend persisted in this workspace's settings */
    savedBackend: EmbeddingBackend
    /** Embedding model persisted in this workspace's settings — '' when none */
    savedModelName: string
    /** Saved config differs from what is loaded — renderer shows "Save to apply" */
    drift: boolean
  }
  chat: {
    plan: RuntimeRoleAssignment | null
    build: RuntimeRoleAssignment | null
  }
  /** Every routable role, resolved through the same chain the runtime uses. */
  roles: RuntimeRoleRow[]
  reachability: {
    ollamaRunning: boolean
    omlxRunning: boolean
  }
}

// ── Ollama ──

/**
 * What a local model can actually do.
 *
 * `unknown` is not a placeholder for "probably chat" — it means nothing told us,
 * so the UI must not claim otherwise. Ollama's /api/tags carries no type at all,
 * which is why every model used to render a green LLM badge.
 */
export type ModelCapability = 'chat' | 'embedding' | 'vision' | 'unknown'

/**
 * Which tier of the detection chain produced a capability. Drives whether the
 * UI asserts the capability or labels it "assumed".
 */
export type CapabilityDetectionSource = 'api-show' | 'family' | 'name-heuristic'

/** One Ollama model with everything /api/tags and /api/show told us about it. */
export interface OllamaModelInfo {
  name: string
  /** Content digest — changes when the tag is re-pulled, so it keys the cache. */
  digest: string
  /** `details.family` from /api/tags, e.g. 'llama', 'bert', 'nomic-bert'. */
  family?: string
  capability: ModelCapability
  /** How we decided — 'name-heuristic' means assumed, not known. */
  detectedVia: CapabilityDetectionSource
}

export interface OllamaStatus {
  installed: boolean
  running: boolean
  version?: string
  models: string[]
  /**
   * Per-model capability. Absent when the server was unreachable — never an
   * empty array standing in for "no models", so callers can tell the two apart.
   */
  modelDetails?: OllamaModelInfo[]
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
  /**
   * True when a guard rail silently reduced index quality (e.g. the workspace
   * exceeded LARGE_WORKSPACE_TAG_THRESHOLD and the full graph rebuild was
   * skipped). Previously this degradation was invisible, so the graph froze at
   * 0 edges with no signal to the user.
   */
  degraded?: boolean
  /** Human-readable explanation shown in the UI when degraded is true. */
  degradedReason?: string
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

// ── Index exclusion preflight ──

/** How the preflight classified a candidate directory. */
export type ExclusionVerdict = 'auto-exclude' | 'needs-confirmation' | 'keep'

/**
 * A directory the exclusion preflight considered excluding from indexing,
 * with the evidence behind its verdict. Tier-2 names (lib, libs, Library, ...)
 * are never excluded without confirmation because they are just as often
 * first-party code.
 */
export interface ExclusionCandidate {
  /** Workspace-relative POSIX path, e.g. "apps/mobile/ios/Pods" */
  relPath: string
  dirName: string
  fileCount: number
  totalBytes: number
  /** Top 5 file extensions by count */
  extensions: Array<{ ext: string; count: number }>
  gitIgnored: boolean
  gitTracked: boolean
  /** LICENSE, *.podspec, Package.swift, *.nuspec, bower.json, CMakeLists.txt */
  vendorMarkers: string[]
  /** Signals the directory holds first-party code (tracked source, recent edits) */
  firstPartyHints: string[]
  verdict: ExclusionVerdict
  reason: string
  /** Whether the UI checkbox should start checked (needs-confirmation only) */
  defaultChecked: boolean
  /** The .atelierignore rule that would be written if confirmed */
  suggestedRule: string
}

export interface ExclusionPreflightResult {
  candidates: ExclusionCandidate[]
  /** True when the walk hit the depth/time budget before finishing */
  truncated: boolean
  durationMs: number
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

/**
 * LLM provider for a workspace.
 *
 * - 'claude'    — Anthropic Claude via the Claude CLI (subscription billing)
 * - 'local-llm' — Ollama / oMLX on the local machine, via OpenCode
 * - 'glm'       — Z.ai GLM via OpenCode's OpenAI-compatible provider. Reached either
 *                 directly (Coding Plan endpoint) or through a local proxy.
 *
 * Executor derivation: 'claude' → CLI; everything else → OpenCode.
 */
export type LLMProvider = 'claude' | 'local-llm' | 'glm'

/**
 * How the GLM provider is reached.
 * - 'zai-coding' — Z.ai Coding Plan endpoint directly (API key required)
 * - 'proxy'      — a self-hosted/local proxy; the key may live in the proxy instead
 */
export type GlmEndpointMode = 'zai-coding' | 'proxy'

/**
 * GLM-hosted REMOTE MCP servers that can be mounted per workspace. All are
 * credit-billed. Must stay in step with {@link GLM_REMOTE_MCP_SERVERS} — an id
 * with no entry there can never be mounted or read.
 *
 * Vision is deliberately absent: it is a local stdio server (`npx @z_ai/mcp-server`)
 * registered as the normal `zai-vision` integration and toggled through
 * `externalMcpActive`, not through this map.
 */
export type GlmMcpServerId = 'web-search' | 'web-reader'

/** Outcome of probing a GLM endpoint's `/models` (Test Connection). */
export interface GlmConnectionResult {
  ok: boolean
  /** Human-safe summary for the settings card. */
  message: string
  /** Model IDs reported by the endpoint, in the order returned. */
  models: string[]
  /** Machine-readable outcome, so the UI can give a targeted hint. */
  code: 'ok' | 'auth-failed' | 'not-found' | 'network' | 'timeout' | 'bad-url'
  /** The exact URL probed — echoed back so a URL mistake is visible, not guessed at. */
  probedUrl?: string
  /**
   * Per-model context/output limits, keyed by model id, for the models that
   * reported them.
   *
   * Z.ai's own `/models` is undocumented and OpenAI-shaped (ids only), so this is
   * usually empty against the Coding Plan endpoint. It is populated by local
   * proxies (LiteLLM and friends) that do publish `context_length` — and those
   * are the deployments where the shipped 200K default is most likely wrong,
   * because the proxy may cap context well below the upstream model.
   */
  modelLimits?: Record<string, { contextLimit?: number; outputLimit?: number }>
}

/**
 * GLM Coding Plan quota consumption against the plan's two rolling windows.
 * Credits, not dollars — a USD figure is meaningless on a subscription.
 */
export interface GlmQuotaStatus {
  /** Credits used in the current 5-hour window. */
  creditsIn5h: number
  /** Credits used in the last 7 days. */
  creditsInWeek: number
  limit5h: number
  limitWeek: number
  percentOf5h: number
  percentOfWeek: number
  /** Whether requests right now bill at the off-peak (half) rate. */
  offPeak: boolean
}

/** Local LLM inference backend */
export type LocalLLMBackend = 'ollama' | 'omlx'

/** Local LLM execution strategy */
export type LocalLLMStrategy = 'default' | 'native'

/**
 * Executor backend — which runtime drives AI interactions.
 * Fully derived from the resolved LLM provider — not user-configurable.
 *
 * Rule: provider === 'claude' → 'cli'; everything else → 'opencode'.
 *
 * - 'cli'     — Claude CLI (stream-json mode) — subscription billing
 * - 'opencode' — OpenCode multi-provider runtime (@opencode-ai/sdk)
 */
export type ExecutorBackend = 'cli' | 'opencode'

/**
 * Typed workspace settings — single source of truth for keys stored in
 * `workspaces.settings_json`. All fields are optional because settings
 * are accumulated incrementally as the user configures things.
 */
export interface WorkspaceSettings {
  // ── Executor / Provider ──
  /** @deprecated Executor is now derived from llmProvider. Kept for tolerant reading of old settings_json. */
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
  /**
   * How a track's work gets back to the mainline. Default `independent` — one
   * PR per track, which is what `/complete` always did. `integration` merges
   * every track into one cumulative branch instead. Per-track overrides live on
   * `work_tracks.landing_mode`.
   */
  landingMode?: 'independent' | 'integration'
  /**
   * Branch new blueprint branches are cut from.
   *
   * `FOLLOW_CHECKOUT` — or absent, which means the same thing — is "whatever
   * the primary checkout has checked out", the behaviour every workspace had
   * before this setting existed. Absence and the sentinel being equivalent is
   * what makes this migration-free: nothing is backfilled, and the UI always
   * writes an explicit value so clearing never has to round-trip an
   * `undefined` through the settings merge.
   *
   * Deliberately NOT auto-populated on upgrade: pinning a workspace to
   * whatever branch it happened to be on would bake an accident into
   * configuration. It is surfaced in Repository settings instead.
   */
  blueprintBaseBranch?: string
  /** Show Ollama provider option in Settings (default false) */
  showOllamaProvider?: boolean

  // ── Local LLM ──
  descriptionModel?: string
  /** Ollama model used for embedding (semantic search). e.g. 'bge-m3', 'nomic-embed-text' */
  ollamaEmbeddingModel?: string

  // ── OpenCode ──
  openCodeProvider?: string
  openCodeModel?: string
  openCodeBaseUrl?: string
  openCodeApiKey?: string

  // ── GLM (Z.ai) ──
  /** Coding Plan API key. Encrypted at rest via safeStorage (see encrypt-settings-keys). */
  glmApiKey?: string
  glmApiKeyEncrypted?: boolean
  /**
   * GLM base URL, stored and used VERBATIM — never normalised or suffixed.
   * Z.ai Coding Plan: `https://api.z.ai/api/coding/paas/v4`.
   * A local proxy uses whatever path layout the proxy exposes.
   */
  glmBaseUrl?: string
  glmEndpointMode?: GlmEndpointMode
  /** Primary GLM model ID (e.g. 'glm-5.3'). */
  glmModel?: string
  /**
   * Housekeeping (title-gen/summarisation) model ID. `''` disables housekeeping
   * entirely; `undefined` falls back to the Flash default.
   */
  glmSmallModel?: string
  /** Which GLM-hosted MCP servers are mounted. All credit-billed — off by default. */
  glmMcpActive?: Partial<Record<GlmMcpServerId, boolean>>
  /** Context/output limits discovered from the provider's /models endpoint. */
  glmContextLimit?: number
  glmOutputLimit?: number
  /** Model IDs reported by the last successful Test Connection. Authoritative over GLM_MODELS. */
  glmDiscoveredModels?: string[]

  // ── GitHub ──
  githubTokenEncrypted?: string
  githubToken?: string
  githubLogin?: string
  githubTokenType?: string

  // ── Blueprint quality gates ──
  /**
   * Human-typed overrides for the deterministic gate commands. Highest
   * precedence — beats both the PLAN phase's declaration and disk detection.
   * Absent keys fall through; an absent object means "detect everything".
   */
  gateCommands?: import('./gate-command-types').GateCommandSet

  /**
   * M6.1 — post-verify lead-review pass. When true, a verify outcome of
   * `passed`/`human_needed` dispatches one whole-diff lead-review pass (spec
   * drift, test gaming, correctness) before the blueprint is marked complete.
   * Default OFF: the pass costs an extra strong-model session per run. The
   * `blueprint:lead-review` role binding stays mandatory either way — it is
   * the escalation ladder's fixer of last resort.
   */
  leadReviewPass?: boolean

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
  'database' | 'code' | 'testing' | 'architecture' | 'security' | 'documentation' | 'ui-ux'

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

/** Where a set of audit findings was routed for remediation. */
export type AuditHandoffTarget = 'chat' | 'blueprint'

/**
 * Record that a finding was handed off for remediation.
 *
 * Findings get a fresh UUID on every run, so these rows are scoped to one run:
 * re-running an auditor legitimately clears the indicator, because the new
 * findings have not been worked on. Handing the same finding off twice is
 * allowed — the UI shows the most recent target and lets the user do it again.
 */
export interface AuditFindingHandoff {
  id: string
  auditRunId: string
  findingId: string
  target: AuditHandoffTarget
  /** Conversation / blueprint id, when the target was created eagerly. */
  refId: string | null
  refTitle: string | null
  createdAt: string
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
  'contrarian' | 'first-principles' | 'expansionist' | 'outsider' | 'executor'

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
  completedAt: string | null
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

/** Phase progress event — emitted during plan build execution */
export interface PhaseProgressEvent {
  planId: string | null
  phaseId: number
  phaseTitle: string
  status: 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  totalPhases: number
  message?: string
  // ── Task-level tracking (optional) ──
  taskId?: string
  taskTitle?: string
  taskStatus?: 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
  totalTasks?: number
}

/** Persisted phase progress entry (stored as JSON in plans.phase_progress_json) */
export interface PhaseProgress {
  phaseId: number
  status: string
  startedAt: string | null
  completedAt: string | null
  /** Files the agent has touched within this phase (populated via tool activity inference) */
  touchedFiles?: string[]
  /** Task-level progress within this phase */
  tasks?: Array<{
    taskId: string
    title: string
    status: string
  }>
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

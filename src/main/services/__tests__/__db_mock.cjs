/**
 * CJS module that provides mock database + repository exports.
 * Used by setup-full-mock.ts Module._load hook to redirect
 * `require('../db/...')` and `require('../db/repositories/...')` to mocked stubs.
 *
 * Each repository singleton is a stub object whose methods are createSpy()-style
 * functions that track calls and allow `.mockReturnValue()` configuration.
 */
'use strict'

// ── Spy factory ──────────────────────────────────────────────────────────────
function createSpy(defaultFn) {
  const spy = function (...args) {
    spy.calls.push(args)
    spy.callCount++
    spy.lastCall = args
    if (spy._mockImpl) return spy._mockImpl(...args)
    if (spy._mockReturnValue !== undefined) return spy._mockReturnValue
    if (spy._mockReturnValueOnce.length > 0) return spy._mockReturnValueOnce.shift()
    if (defaultFn) return defaultFn(...args)
    return undefined
  }
  spy.calls = []
  spy.callCount = 0
  spy.lastCall = null
  spy._mockImpl = null
  spy._mockReturnValue = undefined
  spy._mockReturnValueOnce = []
  spy.mockReturnValue = function (v) {
    spy._mockReturnValue = v
    return spy
  }
  spy.mockReturnValueOnce = function (v) {
    spy._mockReturnValueOnce.push(v)
    return spy
  }
  spy.mockImplementation = function (fn) {
    spy._mockImpl = fn
    return spy
  }
  spy.mockResolvedValue = function (v) {
    spy._mockImpl = async () => v
    return spy
  }
  spy.mockRejectedValue = function (e) {
    spy._mockImpl = async () => {
      throw e
    }
    return spy
  }
  spy.mockReset = function () {
    spy.calls = []
    spy.callCount = 0
    spy.lastCall = null
    spy._mockImpl = null
    spy._mockReturnValue = undefined
    spy._mockReturnValueOnce = []
    return spy
  }
  spy.mockClear = function () {
    spy.calls = []
    spy.callCount = 0
    spy.lastCall = null
    return spy
  }
  spy._isSpy = true
  return spy
}

// ── Database mock ────────────────────────────────────────────────────────────
const noopStmt = {
  run: createSpy(() => ({ changes: 0, lastInsertRowid: 0 })),
  get: createSpy(() => null),
  all: createSpy(() => []),
  pluck: function () {
    return { get: createSpy(() => null), all: createSpy(() => []) }
  },
  bind: function () {
    return noopStmt
  },
  columns: function () {
    return []
  },
  iterate: function* () {
    /* no rows to yield in this mock */
  }
}

function createMockDatabase() {
  return {
    prepare: createSpy(() => ({
      run: createSpy(() => ({ changes: 0, lastInsertRowid: 0 })),
      get: createSpy(() => null),
      all: createSpy(() => []),
      pluck: function () {
        return { get: createSpy(() => null), all: createSpy(() => []) }
      },
      bind: function () {
        return this
      },
      columns: function () {
        return []
      },
      iterate: function* () {
    /* no rows to yield in this mock */
  }
    })),
    transaction: createSpy(function (fn) {
      const txFn = function (...args) {
        return fn(...args)
      }
      txFn.deferred = txFn
      txFn.immediate = txFn
      txFn.exclusive = txFn
      return txFn
    }),
    exec: createSpy(),
    pragma: createSpy(() => []),
    close: createSpy(),
    inTransaction: false,
    open: true,
    readonly: false,
    name: ':memory:',
    memory: true
  }
}

let mockDb = createMockDatabase()

function getDatabase() {
  return mockDb
}

function resetDatabase() {
  mockDb = createMockDatabase()
}

// ── Repository stub factory ──────────────────────────────────────────────────
function stubRepo(methods) {
  const repo = {}
  for (const m of methods) {
    repo[m] = createSpy()
  }
  // Add BaseRepository methods that all repos inherit
  if (!repo.findById) repo.findById = createSpy(() => undefined)
  if (!repo.findOneBy) repo.findOneBy = createSpy(() => undefined)
  if (!repo.findManyBy) repo.findManyBy = createSpy(() => [])
  if (!repo.deleteBy) repo.deleteBy = createSpy(() => 0)
  if (!repo.deleteById) repo.deleteById = createSpy(() => 0)
  // The db() method
  repo.db = function () {
    return getDatabase()
  }
  return repo
}

// ── All 38+ repository stubs ─────────────────────────────────────────────────
const repos = {
  conversationRepository: stubRepo([
    'create',
    'findByWorkspace',
    'updateTitle',
    'delete',
    'updateMode',
    'archive',
    'updateSessionId',
    'getSessionId',
    'getWorkspaceId',
    'updateBranchName',
    'updatePrInfo',
    'updateMcpOverrides',
    'updateEffort',
    'updateTone',
    'updateSummary',
    'getSummary',
    'updateHandoffContext',
    'updateModelSnapshot',
    'findByAuditRunId',
    'reorderConversations'
  ]),
  messageRepository: stubRepo([
    'create',
    'findByConversation',
    'findRecentByConversation',
    'getLastMessageTimestamp',
    'findById',
    'truncateAfterTimestamp',
    'updateToolActivities',
    'updatePlanAction'
  ]),
  workspaceRepository: stubRepo([
    'create',
    'findAll',
    'findById',
    'findByPath',
    'updateLastOpened',
    'delete',
    'updateSettings',
    'getSettings',
    'getSettingsByPath',
    'updateConstitution'
  ]),
  specialistRepository: stubRepo([
    'findAll',
    'findByAgentId',
    'findActive',
    'findReadyByWorkspace',
    'create',
    'update',
    'delete',
    'deleteAll',
    'assignSkill',
    'removeSkill',
    'getSkills',
    'getAllSkills',
    'findSpecialistsForSkill',
    'findAllWithSkills',
    'reorderPriorities',
    'canDelete'
  ]),
  skillRepository: stubRepo([
    'findAll',
    'findByFilename',
    'findActive',
    'create',
    'update',
    'delete',
    'deleteAll',
    'setActive',
    'updateSummaries',
    'updateTiers',
    'updateEnrichment',
    'getSummary'
  ]),
  conversationSpecialistRepository: stubRepo([
    'findByConversation',
    'findByConversationAndSpecialist',
    'upsert',
    'remove',
    'removeAll',
    'initFromWorkspaceDefaults',
    'replaceConversationSpecialists'
  ]),
  agentSessionRepository: stubRepo([
    'create',
    'complete',
    'completeWithBreakdown',
    'updateConversationId',
    'updateTokenUsage',
    'findByWorkspace',
    'getTokenSummary',
    'getConversationTokenSummary',
    'buildTokenSummary',
    'terminateStale',
    'getRecent'
  ]),
  turnUsageRepository: stubRepo([
    'record',
    'findByConversation',
    'getLastTurn',
    'updateLastTurnTokens',
    'updateLastTurnContextTokens',
    'pruneOlderThan'
  ]),
  checkpointRepository: stubRepo(['findByConversation']),
  eventRepository: stubRepo([
    'create',
    'findByConversation',
    'getRecent',
    'getRecentByWorkspace',
    'pruneOlderThan'
  ]),
  appPreferenceRepository: stubRepo(['get', 'set', 'getBool', 'getInt', 'getAppPreferences']),
  userProfileRepository: stubRepo(['getProfile', 'upsertProfile']),
  ideaRepository: stubRepo([
    'create',
    'findByWorkspace',
    'findByGrillConversation',
    'update',
    'updateField',
    'updateStatus',
    'setGrillConversation',
    'setGrillSummary',
    'setConvertedConversation',
    'saveGrillDecisions',
    'clearGrillDecisions',
    'delete'
  ]),
  grillSessionRepository: stubRepo([
    'findByIdeaId',
    'create',
    'findById',
    'updateStatus',
    'appendMessages',
    'updateScore',
    'updateQuestionStates',
    'updateTrackId',
    'linkToWorkspace',
    'savePlan',
    'getPlan',
    'completeAndStrip',
    'deleteByIdeaId',
    'findIdeaIdsWithPlan',
    'terminateStale',
    'getActiveForWorkspace'
  ]),
  memoryFactRepository: stubRepo([
    'findByWorkspace',
    'findAllByWorkspace',
    'findByCategory',
    'search',
    'createFact',
    'updateFact',
    'setWorkspaceScope',
    'confirmFact',
    'supersedeFact',
    'archiveFact',
    'setEmbedding',
    'findPendingEmbeddings',
    'findWithEmbeddings',
    'touchFacts',
    'countByWorkspace',
    'findStale',
    'decayFacts',
    'createContradiction',
    'findContradictions',
    'findContradictionsPaged',
    'countContradictions',
    'bulkAutoResolveDuplicates',
    'resolveContradiction',
    'getDocState',
    'upsertDocState',
    'findAllDocStates',
    'addConfirmation',
    'getConfirmations',
    'countConfirmationDays',
    'countConfirmationSourceTypes',
    'hasHumanConfirmation',
    'getWeightedConfirmationSum',
    'getEvidenceCounts',
    'setVolatile',
    'reparentConfirmations',
    'mergeFact',
    'updateFactInPlace',
    'findVolatileFacts',
    'pruneOldContradictions',
    'countPendingContradictions'
  ]),
  auditRepository: stubRepo([
    'createRun',
    'createResults',
    'updateResult',
    'updateRun',
    'getHistoryForWorkspace',
    'findRunById',
    'deleteRun',
    'getLatestForWorkspace',
    'findResultById',
    'findResultsByRunId',
    'findResultByTrack'
  ]),
  auditPlanRepository: stubRepo(['savePlan', 'getPlansForRun']),
  blueprintRepository: stubRepo([
    'create',
    'findByWorkspace',
    'findByStatus',
    'updateStatus',
    'updatePhase',
    'updateShortName',
    'update',
    'delete',
    'markStaleAsFailed'
  ]),
  blueprintPhaseRepository: stubRepo([
    'create',
    'createAllPhases',
    'findByBlueprint',
    'findByBlueprintAndPhase',
    'updateStatus',
    'setConversation',
    'saveArtifacts',
    'appendArtifact',
    'replaceArtifactOfType',
    'saveContextSnapshot'
  ]),
  blueprintTaskRepository: stubRepo([
    'create',
    'createBulk',
    'findByBlueprint',
    'findByWave',
    'getWaveCount',
    'updateStatus',
    'setExecutorRun',
    'deleteByBlueprint',
    'deleteRemediationTasks',
    'setCompletion'
  ]),
  blueprintEventRepository: stubRepo([
    'nextSeq',
    'append',
    'findByBlueprint',
    'findByBlueprintAfterSeq',
    'countByBlueprint',
    'deleteByBlueprint'
  ]),
  planRepository: stubRepo([
    'savePlan',
    'getById',
    'getForWorkspace',
    'findActiveByConversationId',
    'findBySource',
    'updateStatus',
    'markHandedOff',
    'markInProgress',
    'markCompleted',
    'markArchived',
    'deletePlan',
    'enforceRetention',
    'recordStatusChange',
    'getStatusHistory',
    'updatePhaseProgress',
    'getPhaseProgress',
    'getSupersedingPlan',
    'getPreviousPlan'
  ]),
  todoRepository: stubRepo([
    'saveTodo',
    'completeTodo',
    'removeTodo',
    'syncTodos',
    'findByConversation',
    'clearByConversation'
  ]),
  councilSessionRepository: stubRepo([
    'createSession',
    'updatePhase',
    'appendAdvisorReview',
    'savePeerReviews',
    'saveVerdict',
    'saveTranscript',
    'updateStatus',
    'deleteSession',
    'findByWorkspace',
    'findResumable',
    'markStaleAsFailed'
  ]),
  usageLogRepository: stubRepo([
    'record',
    'buildSummary',
    'getWorkspaceSummary',
    'getConversationSummary',
    'getGlobalSummary',
    'pruneOlderThan'
  ]),
  codeChunkRepository: stubRepo([
    'upsertChunks',
    'findByWorkspace',
    'findByFile',
    'deleteByFile',
    'deleteByWorkspace',
    'getFileMtimes',
    'countByWorkspace'
  ]),
  chunkEmbeddingRepository: stubRepo([
    'upsertEmbeddings',
    'loadAllForWorkspace',
    'deleteByWorkspace',
    'hasEmbeddings',
    'countByWorkspace'
  ]),
  codeGraphEdgeRepository: stubRepo([
    'upsertEdges',
    'upsertEdgesBatched',
    'findByWorkspace',
    'findCallersOf',
    'findCalleesOf',
    'deleteByWorkspace',
    'findDependenciesOf',
    'findDependentsOf',
    'countByWorkspace',
    'findCoupledFiles',
    'getModuleBoundaryMetrics',
    'findTransitiveDependents'
  ]),
  codeGraphTagRepository: stubRepo([
    'upsertTags',
    'findDefsByWorkspace',
    'findByFile',
    'searchByName',
    'getFileMtimes',
    'deleteByFile',
    'deleteByWorkspace',
    'findAllByWorkspace',
    'findDeadCode',
    'findSymbolHotspots',
    'countByWorkspace'
  ]),
  codeGraphRankRepository: stubRepo([
    'upsertRanks',
    'findByWorkspace',
    'getRank',
    'deleteByWorkspace',
    'countByWorkspace',
    'getTopRanked'
  ]),
  libraryDocRepository: stubRepo([
    'upsertSections',
    'searchDocs',
    'listPackages',
    'isCached',
    'deleteByWorkspace'
  ]),
  mpaCampaignRepository: stubRepo([
    'create',
    'findById',
    'findByWorkspace',
    'updateStatus',
    'markStaleAsFailed'
  ]),
  mpaRunRepository: stubRepo([
    'createRun',
    'findByCampaign',
    'deleteByCampaignOrder',
    'findById',
    'findByWorkspace',
    'updateRun',
    'createPhase',
    'findPhasesByRun',
    'updatePhase',
    'appendStreamContent',
    'markStaleAsFailed',
    'findResumable'
  ]),
  mpaArtifactRepository: stubRepo(['create', 'findById', 'findByRun']),
  e2eTestRunRepository: stubRepo([
    'create',
    'findByWorkspace',
    'updateStatus',
    'updateTotals',
    'recoverOrphanedRuns'
  ]),
  e2eTestResultRepository: stubRepo([
    'create',
    'createMany',
    'findByRun',
    'summariesByRun',
    'updateStatus',
    'findFailedByRun',
    'countByStatus'
  ]),
  handoffRepository: stubRepo([
    'create',
    'getById',
    'getForWorkspace',
    'getPending',
    'accept',
    'reject',
    'markFailed',
    'expireStale',
    'getChain',
    'getBySourceSession',
    'detectLoopInChain',
    'deleteHandoff',
    'enforceRetention',
    'parseEnvelope'
  ]),
  bugRepository: stubRepo([
    'upsertBug',
    'getAll',
    'getById',
    'markResolved',
    'markUnresolved',
    'deleteBug',
    'updateNote',
    'getUnresolvedCount'
  ]),
  coreAgentAliasRepository: stubRepo(['findAll', 'upsert']),
  coreAgentPromptRepository: stubRepo(['findAll', 'findByRoleAndMode', 'upsert', 'resetToDefault'])
}

// ── Utility exports for chunk-embedding ──────────────────────────────────────
function serializeEmbedding(arr) {
  return Buffer.from(new Float32Array(arr).buffer)
}
function deserializeEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

// ── BaseRepository mock class ────────────────────────────────────────────────
class BaseRepository {
  db() {
    return getDatabase()
  }
  findOneBy() {
    return undefined
  }
  findById() {
    return undefined
  }
  findManyBy() {
    return []
  }
  deleteBy() {
    return 0
  }
  deleteById() {
    return 0
  }
  runTransaction(fn) {
    return fn()
  }
}

// ── Reset all spies across all repositories ──────────────────────────────────
function resetAllRepos() {
  for (const repoName of Object.keys(repos)) {
    const repo = repos[repoName]
    for (const methodName of Object.keys(repo)) {
      if (repo[methodName] && repo[methodName]._isSpy) {
        repo[methodName].mockReset()
      }
    }
  }
}

// ── Export everything ────────────────────────────────────────────────────────
module.exports = {
  // Spy factory
  createSpy,
  // Database
  getDatabase,
  resetDatabase,
  createMockDatabase,
  SCHEMA_SQL: '',
  CURRENT_SCHEMA_VERSION: 129,
  migrations: [],
  // Base class
  BaseRepository,
  // All repositories
  ...repos,
  // Utility exports for chunk-embedding
  serializeEmbedding,
  deserializeEmbedding,
  // Bulk reset
  resetAllRepos,
  // Individual repo access by name (for getMockRepo helper)
  _repos: repos
}

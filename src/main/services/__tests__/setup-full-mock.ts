/**
 * Full module mock — extends electron-stub.ts to intercept database, repository,
 * and service singleton imports.
 *
 * Usage:
 *   1. import { setupFullMock, getMockRepo, createSpy, ... } from './setup-full-mock'
 *   2. setupFullMock() — must be called BEFORE importing any service module
 *   3. const { myService } = require('../my-service') — dynamic require after mock is active
 *   4. getMockRepo('blueprint').findById.mockReturnValue({ ... })
 *
 * This enables deep body coverage for services that import from '../db/repositories',
 * '../db/index', and other singleton services.
 */
import Module from 'node:module'
import path from 'node:path'
import {
  setupElectronStub,
  mockMainWindow,
  mockEvent,
  getHandlers,
  sentEvents,
  resetStub
} from './electron-stub'

// ── Resolved paths ───────────────────────────────────────────────────────────
const dbMockPath = path.resolve(__dirname, '__db_mock.cjs')
let dbMock: any = null

function getDbMock(): any {
  if (!dbMock) {
    dbMock = require(dbMockPath)
  }
  return dbMock
}

// ── createSpy re-export from dbMock ──────────────────────────────────────────
export function createSpy(defaultFn?: (...args: any[]) => any): any {
  return getDbMock().createSpy(defaultFn)
}

// ── Repository access ────────────────────────────────────────────────────────

const REPO_NAME_MAP: Record<string, string> = {
  blueprint: 'blueprintRepository',
  blueprintPhase: 'blueprintPhaseRepository',
  blueprintTask: 'blueprintTaskRepository',
  blueprintEvent: 'blueprintEventRepository',
  conversation: 'conversationRepository',
  message: 'messageRepository',
  workspace: 'workspaceRepository',
  specialist: 'specialistRepository',
  skill: 'skillRepository',
  conversationSpecialist: 'conversationSpecialistRepository',
  agentSession: 'agentSessionRepository',
  turnUsage: 'turnUsageRepository',
  checkpoint: 'checkpointRepository',
  event: 'eventRepository',
  appPreference: 'appPreferenceRepository',
  userProfile: 'userProfileRepository',
  idea: 'ideaRepository',
  grillSession: 'grillSessionRepository',
  memoryFact: 'memoryFactRepository',
  audit: 'auditRepository',
  auditPlan: 'auditPlanRepository',
  plan: 'planRepository',
  todo: 'todoRepository',
  councilSession: 'councilSessionRepository',
  usageLog: 'usageLogRepository',
  codeChunk: 'codeChunkRepository',
  chunkEmbedding: 'chunkEmbeddingRepository',
  codeGraphEdge: 'codeGraphEdgeRepository',
  codeGraphTag: 'codeGraphTagRepository',
  codeGraphRank: 'codeGraphRankRepository',
  libraryDoc: 'libraryDocRepository',
  mpaCampaign: 'mpaCampaignRepository',
  mpaRun: 'mpaRunRepository',
  mpaArtifact: 'mpaArtifactRepository',
  e2eTestRun: 'e2eTestRunRepository',
  e2eTestResult: 'e2eTestResultRepository',
  handoff: 'handoffRepository',
  track: 'trackRepository',
  bug: 'bugRepository',
  coreAgentAlias: 'coreAgentAliasRepository',
  coreAgentPrompt: 'coreAgentPromptRepository'
}

/**
 * Get a mock repository by short name (e.g., 'blueprint') or full name (e.g., 'blueprintRepository').
 * All methods are createSpy() instances with .mockReturnValue(), .mockImplementation(), etc.
 */
export function getMockRepo(name: string): any {
  const mock = getDbMock()
  // Try short name map first
  const fullName = REPO_NAME_MAP[name] || name
  const repo = mock._repos[fullName] || mock[fullName]
  if (!repo) {
    throw new Error(
      `Unknown repository: "${name}". Available: ${Object.keys(REPO_NAME_MAP).join(', ')}`
    )
  }
  return repo
}

/** Get the mock database instance */
export function getMockDb(): any {
  return getDbMock().getDatabase()
}

/**
 * Drop cached modules whose path contains any of `fragments`, so the next
 * `require()` re-executes them under the currently-installed mock loader.
 *
 * Call this AFTER `setupFullMock()` and BEFORE requiring the module under test.
 *
 * Why it is needed: `Module._load` interception only affects modules loaded
 * while it is installed. If an earlier file in a shared run already imported
 * the service under test, that module sits in `require.cache` bound to the REAL
 * repositories, and `getMockRepo(...).mockReturnValue(...)` then configures an
 * object the service never reads — the test passes standalone and fails in the
 * suite. Evicting just the leaf module under test re-binds it to the mocks.
 *
 * Keep the fragments narrow (one service file). Evicting broadly re-executes
 * half of a circular import pair while its partner stays cached, which is what
 * `restoreFullMock()`'s notes warn about.
 */
export function evictFromCache(...fragments: string[]): void {
  for (const key of Object.keys(require.cache)) {
    if (fragments.some((f) => key.includes(f))) delete require.cache[key]
  }
}

// ── Service singleton mocks ──────────────────────────────────────────────────
// Services that are imported as singletons by other services.
// We intercept their module paths to return controllable mock objects.

const serviceMocks: Map<string, any> = new Map()

/**
 * Register a mock for a service singleton. The mock will be returned when
 * any module tries to import the matching service file.
 */
export function mockService(servicePath: string, mockObj: any): void {
  serviceMocks.set(servicePath, mockObj)
}

/**
 * Drop a single service mock registered by `mockService()`.
 *
 * `serviceMocks` is process-global and `restoreFullMock()` deliberately leaves
 * it populated, so a mock registered by one file is still consulted by the next
 * file that calls `setupFullMock()`. Files that only need a service stubbed
 * while their own modules load should unregister it afterwards rather than
 * leave it to hijack a later file's `require()`.
 */
export function unmockService(servicePath: string): void {
  serviceMocks.delete(servicePath)
}

/**
 * Create a mock service object with createSpy() methods.
 */
export function createMockService(methods: string[]): any {
  const svc: any = {}
  for (const m of methods) {
    svc[m] = createSpy()
  }
  return svc
}

// ── Module interception ─────────────────────────────────────────────────────

let fullMockInstalled = false
// Holds the pre-patch Module._load so restoreFullMock() can undo the interception.
// Module-scoped (not a local inside setupFullMock()) so restoreFullMock() can reach it.
let origLoad: any = null
// Resolved filenames of PROJECT modules loaded through the patched loader while
// the full mock was installed (the "mock window"). restoreFullMock() purges these
// from require.cache so no later file inherits a mock-bound copy. Null when the
// mock is not installed.
let mockWindowModules: Set<string> | null = null

/**
 * Install the full module mock. Extends setupElectronStub() to also intercept
 * database, repository, and service modules.
 *
 * Must be called BEFORE importing any service/IPC module.
 * Safe to call multiple times — only installs once.
 *
 * IMPORTANT — this patches the process-global `Module._load` with no automatic
 * expiry. In a unified run (run-all.ts) that dynamically imports many test files
 * in one process, every module loaded AFTER this one — including real
 * `db/repositories/*.repository.ts` files required by later, non-mocked
 * repository tests — would otherwise be silently redirected to this mock,
 * contributing zero real coverage. Call `restoreFullMock()` once this file's
 * module-level `require()`s have run (run-all.ts does this automatically after
 * every dynamic import) to scope the interception to this file only.
 */
export function setupFullMock(): void {
  if (fullMockInstalled) return
  fullMockInstalled = true

  // First install electron stubs
  setupElectronStub()

  // Pre-load the db mock module
  dbMock = require(dbMockPath)

  // Now extend Module._load with database/repository interception
  origLoad = (Module as any)._load
  mockWindowModules = new Set<string>()
  ;(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    // ── Database core ──
    if (request === 'better-sqlite3') {
      return function Database() {
        return dbMock.getDatabase()
      }
    }
    if (matchesDbIndex(request, parent)) {
      return {
        getDatabase: dbMock.getDatabase,
        SCHEMA_SQL: '',
        CURRENT_SCHEMA_VERSION: dbMock.CURRENT_SCHEMA_VERSION,
        migrations: [],
        default: { getDatabase: dbMock.getDatabase }
      }
    }
    if (matchesBaseRepo(request, parent)) {
      return { BaseRepository: dbMock.BaseRepository }
    }

    // ── Repository barrel (../db/repositories or ../db/repositories/index) ──
    if (matchesRepoBarel(request, parent)) {
      return dbMock
    }

    // ── Individual repository files ──
    if (matchesIndividualRepo(request, parent)) {
      return resolveIndividualRepo(request)
    }

    // ── Service singleton mocks ──
    for (const [svcPath, svcMock] of serviceMocks) {
      if (request.includes(svcPath)) {
        return svcMock
      }
    }

    // ── @opencode-ai/sdk ──
    if (request === '@opencode-ai/sdk') {
      return createOpencodeSdkMock()
    }

    // ── @huggingface/transformers ──
    if (request === '@huggingface/transformers') {
      return createHuggingfaceMock()
    }

    // ── onnxruntime-web / onnxruntime-node ──
    if (request === 'onnxruntime-web' || request === 'onnxruntime-node') {
      return createOnnxRuntimeMock()
    }

    // ── node-pty ──
    if (request === 'node-pty') {
      return createNodePtyMock()
    }

    // ── jsdom (for memory-bootstrap doc reading) ──
    // Let it pass through — jsdom works fine in Node

    // ── child_process spawn/exec interception (for CLI executor tests) ──
    // Not intercepted at module level — tests mock these individually

    // ── Electron already handled by setupElectronStub ──
    // ── electron-log already handled by setupElectronStub ──
    // ── .sql?raw files already handled by setupElectronStub ──

    // Pass-through: remember the resolved project module so restoreFullMock()
    // can purge its (potentially mock-bound) cache entry later.
    recordMockWindowModule(request, parent)
    return origLoad.call(this, request, parent, isMain)
  }
}

/**
 * Record the resolved filename of a pass-through require issued while the full
 * mock loader is installed. Only modules FIRST loaded during the mock window
 * are recorded — a module already sitting in require.cache keeps its pre-window
 * bindings (the patched loader returns the cached entry untouched), so evicting
 * it would only orphan references other files already hold and mint duplicate
 * singletons. Additional filters:
 * - Node builtins resolve to non-absolute ids ("fs", "node:path") — skipped.
 * - node_modules deps pass through the mock untouched, so their bindings are
 *   identical to a load outside the window; re-executing them buys nothing and
 *   risks native/global side effects — skipped.
 * - The db/electron mock modules themselves must survive (their loaders cache
 *   references to them) — skipped.
 */
function recordMockWindowModule(request: string, parent: any): void {
  if (!mockWindowModules) return
  try {
    const filename = (Module as any)._resolveFilename(request, parent)
    if (
      typeof filename === 'string' &&
      path.isAbsolute(filename) &&
      !filename.includes('node_modules') &&
      filename !== dbMockPath &&
      !filename.includes('__electron_mock') &&
      require.cache[filename] === undefined
    ) {
      mockWindowModules.add(filename)
    }
  } catch {
    /* unresolvable request — origLoad will fail on it too; nothing to record */
  }
}

// ── Path matching helpers ────────────────────────────────────────────────────

function matchesDbIndex(request: string, parent: any): boolean {
  if (request.endsWith('/db/index') || request.endsWith('/db')) return true
  if (request === '../db/index' || request === '../../db/index' || request === '../db') return true
  if (request === './index' && parent?.filename?.includes('/db/')) return true
  return false
}

function matchesBaseRepo(request: string, parent: any): boolean {
  if (request.endsWith('/db/base-repository') || request.endsWith('/base-repository')) {
    if (parent?.filename?.includes('/db/') || request.includes('/db/')) return true
  }
  return false
}

function matchesRepoBarel(request: string, _parent: any): boolean {
  if (request.endsWith('/db/repositories') || request.endsWith('/db/repositories/index'))
    return true
  if (request === '../db/repositories' || request === '../../db/repositories') return true
  if (request === '../../../db/repositories') return true
  return false
}

function matchesIndividualRepo(request: string, _parent: any): boolean {
  return (
    /\/repositories\/[\w-]+\.repository/.test(request) ||
    /\.\.\/.*repositories\/[\w-]+\.repository/.test(request)
  )
}

function resolveIndividualRepo(request: string): any {
  const mock = getDbMock()
  // Extract the repository name from the path
  const match = request.match(/\/([\w-]+)\.repository/)
  if (!match) return mock

  const fileName = match[1] // e.g., 'blueprint', 'memory-fact', 'app-preference'
  // Map kebab-case filename to camelCase repository name
  const camelName = fileName.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())

  // Blueprint repo exports multiple repositories
  if (fileName === 'blueprint') {
    return {
      BlueprintRepository: mock.BaseRepository,
      blueprintRepository: mock.blueprintRepository,
      BlueprintPhaseRepository: mock.BaseRepository,
      blueprintPhaseRepository: mock.blueprintPhaseRepository,
      BlueprintTaskRepository: mock.BaseRepository,
      blueprintTaskRepository: mock.blueprintTaskRepository
    }
  }

  // Blueprint-event repo
  if (fileName === 'blueprint-event') {
    return {
      BlueprintEventRepository: mock.BaseRepository,
      blueprintEventRepository: mock.blueprintEventRepository
    }
  }

  // Generic individual repo — exports both class and singleton
  const repoName = camelName + 'Repository'
  const repo = mock._repos[repoName] || mock[repoName]
  if (repo) {
    const result: any = {}
    // Add the Class export (capitalized)
    const className = camelName.charAt(0).toUpperCase() + camelName.slice(1) + 'Repository'
    result[className] = mock.BaseRepository
    result[repoName] = repo
    // Add utility exports for chunk-embedding
    if (fileName === 'chunk-embedding') {
      result.serializeEmbedding = mock.serializeEmbedding
      result.deserializeEmbedding = mock.deserializeEmbedding
    }
    return result
  }

  // Fallback — return the full mock
  return mock
}

// ── External library mocks ───────────────────────────────────────────────────

function createOpencodeSdkMock(): any {
  return {
    createClient: createSpy(() => ({
      session: {
        create: createSpy(async () => ({ id: 'mock-session-id' })),
        prompt: createSpy(async function* () {
          /* no-op: yields no events by default */
        }),
        cancel: createSpy(async () => {}),
        list: createSpy(async () => [])
      },
      listModels: createSpy(async () => [])
    })),
    default: {}
  }
}

function createHuggingfaceMock(): any {
  return {
    pipeline: createSpy(async () => createSpy(async () => [[{ score: 0.5 }]])),
    env: { localModelPath: '', cacheDir: '', allowRemoteModels: false }
  }
}

function createOnnxRuntimeMock(): any {
  return {
    InferenceSession: {
      create: createSpy(async () => ({
        run: createSpy(async () => ({})),
        release: createSpy()
      }))
    },
    Tensor: class MockTensor {
      data: any
      dims: any
      type: any
      constructor(type: any, data: any, dims: any) {
        this.type = type
        this.data = data
        this.dims = dims
      }
    },
    env: { wasm: {} }
  }
}

function createNodePtyMock(): any {
  const EventEmitter = require('node:events')
  return {
    spawn: createSpy(() => {
      const pty = new EventEmitter()
      pty.write = createSpy()
      pty.resize = createSpy()
      pty.kill = createSpy()
      pty.pid = 12345
      pty.process = 'mock-pty'
      return pty
    })
  }
}

// ── Reset everything ─────────────────────────────────────────────────────────

/** Reset all mock state — repositories, database, captured handlers, sent events */
export function resetAllMocks(): void {
  getDbMock().resetAllRepos()
  getDbMock().resetDatabase()
  resetStub()
  serviceMocks.clear()
}

/**
 * Undo setupFullMock()'s Module._load interception, restoring the original
 * loader — then purge every project module that was loaded while the mock was
 * installed. No-op if setupFullMock() was never called (or has already been
 * restored) — safe to call unconditionally after every test file in a
 * unified run.
 *
 * Why restore alone is not enough: `Module._load` interception only affects
 * modules loaded while it is installed, but the require cache is keyed by path
 * and not by what was installed at the time. A service first cached under a
 * full-mock file keeps its MOCK repository bindings for the rest of the run —
 * a later file that patches the REAL repository object configures an object
 * the cached service never reads (the identity split behind the order-dependent
 * `undefined.parallelBuildAgents` TypeError in blueprint-build.service and the
 * council "null first write" failure: each passed standalone, failed in-suite).
 *
 * The purge is deliberately narrow — only filenames recorded by
 * `recordMockWindowModule()` during THIS mock window:
 *   - project source only (no node_modules, no builtins, not the mock modules),
 *   - only modules that actually resolved through the patched loader (a module
 *     loaded before the window, or never touched by it, is never evicted),
 *   - the whole window set is evicted at once, and the next requires re-execute
 *     in natural dependency order — the same fresh-load semantics a standalone
 *     run of the next file already has.
 *
 * An earlier, BROADER purge attempt (every /services/, /ipc/, /db/ entry, later
 * "everything created since setupFullMock()") crashed because it evicted
 * modules that never saw the mock and broke circular require pairs out of
 * order. Recording the exact pass-through set avoids both failure modes.
 *
 * Consequence: modules with singleton side effects re-initialize on their next
 * require — desired, and identical to standalone-run behavior. Already-loaded
 * test files keep their closed-over bindings (harmless — they finished
 * loading, and the runners drain their async tests before restoring).
 *
 * Does NOT clear `serviceMocks` or captured mock state (that's
 * `resetAllMocks()`'s job) — it only reverses the module-loader patch, so a
 * file that calls `setupFullMock()` again later re-installs cleanly.
 */
export function restoreFullMock(): void {
  if (!fullMockInstalled) return
  if (origLoad) {
    ;(Module as any)._load = origLoad
  }

  if (mockWindowModules) {
    for (const id of mockWindowModules) {
      delete require.cache[id]
    }
    mockWindowModules = null
  }

  fullMockInstalled = false
  origLoad = null
}

// ── Re-exports from electron-stub ────────────────────────────────────────────
export { mockMainWindow, mockEvent, getHandlers, sentEvents }
export { setupElectronStub, resetStub } from './electron-stub'
export { invokeHandler, tryInvokeHandler } from './electron-stub'

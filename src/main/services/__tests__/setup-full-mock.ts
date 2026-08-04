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

    return origLoad.call(this, request, parent, isMain)
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
        prompt: createSpy(async function* () {}),
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
 * loader. No-op if setupFullMock() was never called (or has already been
 * restored) — safe to call unconditionally after every test file in a
 * unified run.
 *
 * This is the fix for global mock pollution: without it, `Module._load`
 * stays patched for the lifetime of the process, so every module imported
 * later — including real `db/repositories/*.repository.ts` files pulled in
 * by later, non-mocked repository tests — silently resolves to this mock
 * instead of the real implementation, contributing zero real coverage.
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
  fullMockInstalled = false
  origLoad = null
}

// ── Re-exports from electron-stub ────────────────────────────────────────────
export { mockMainWindow, mockEvent, getHandlers, sentEvents }
export { setupElectronStub } from './electron-stub'
export { invokeHandler, tryInvokeHandler } from './electron-stub'

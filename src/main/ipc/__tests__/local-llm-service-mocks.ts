/**
 * Offline stubs for the local-LLM service singletons.
 *
 * The IPC handler-body tests invoke every registered channel with generic args,
 * and these singletons do real, externally visible work when they run for real:
 *
 *   - `ollamaManager.removeModel()`  → DELETE /api/delete against a live Ollama
 *   - `ollamaManager.pullModel()`    → starts a real multi-GB model download
 *   - `ollamaManager.startOllama()`  → `open -a Ollama`
 *   - `omlxManager.startOmlx()`      → `open -a oMLX`
 *   - every `checkStatus()` / `loadModel()` / `unloadModel()` → HTTP to
 *     127.0.0.1:11434 or :8000 — the source of the `/admin/api/models/…` 404
 *     flood in oMLX's server.log
 *
 * Registering these keeps the handler bodies executing end to end (that is what
 * the tests measure) while the I/O stops at the service boundary.
 *
 * Call BEFORE the IPC modules under test are loaded — `mockService` is consulted
 * by setup-full-mock's `Module._load` patch at require time, not at call time —
 * and call the returned disposer once they are loaded. `serviceMocks` is
 * process-global and survives `restoreFullMock()`, so leaving these registered
 * would hand the stubs to the next file that calls `setupFullMock()`.
 *
 * Deliberately does NOT stub `local-embedding.provider`. That singleton is
 * shared by indexing.ipc and embedding.ipc, and embedding-workspace-alignment
 * .test asserts on a `configureForWorkspace` shadow it installs on the real
 * object — a module that first loads while a provider stub is registered binds
 * to the stub for the rest of the process and never sees the shadow. Stubbing
 * the two managers is enough: with oMLX reported as not running, the provider's
 * network paths are never reached.
 *
 * Installs are ref-counted so concurrently running tests can each hold one.
 */
import { mockService, unmockService, createSpy } from '../../services/__tests__/setup-full-mock'

const offlineOllamaStatus = { installed: false, running: false, models: [] as string[] }

const MOCKED_PATHS = ['ollama-manager.service', 'omlx-manager.service']

let liveInstalls = 0

/** Install the stubs; returns a disposer that unregisters them. */
export function installLocalLlmServiceMocks(): () => void {
  liveInstalls += 1
  if (liveInstalls === 1) install()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    liveInstalls -= 1
    if (liveInstalls === 0) MOCKED_PATHS.forEach(unmockService)
  }
}

function install(): void {
  mockService('ollama-manager.service', {
    ollamaManager: {
      // registerOllamaIpc subscribes to pullProgress/pullComplete/pullError
      on: createSpy(() => undefined),
      off: createSpy(() => undefined),
      checkStatus: createSpy(async () => ({ ...offlineOllamaStatus })),
      pullModel: createSpy(async () => undefined),
      cancelPull: createSpy(() => undefined),
      removeModel: createSpy(async () => undefined),
      startOllama: createSpy(async () => false),
      embed: createSpy(async () => [])
    }
  })

  mockService('omlx-manager.service', {
    omlxManager: {
      checkStatus: createSpy(async () => ({ ...offlineOllamaStatus, allModels: [] })),
      startOmlx: createSpy(async () => false),
      getAdminUrl: createSpy((baseUrl?: string) => `${baseUrl ?? 'http://127.0.0.1:8000'}/admin`),
      loadModel: createSpy(async () => undefined),
      unloadModel: createSpy(async () => undefined)
    }
  })
}

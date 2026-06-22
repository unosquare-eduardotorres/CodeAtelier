// @ts-nocheck — TODO: fix after blueprint refactoring
import { useState, useEffect, useCallback } from 'react'
import { useToastStore } from '@renderer/store'
import type {
  LocalLLMBackend,
  OllamaStatus,
  OmlxExtendedStatus
} from '../../../../../shared/types'

// ── Backend config map ──

interface BackendConfig {
  label: string
  statusCheck: (baseUrl: string, apiKey?: string) => Promise<OllamaStatus | OmlxExtendedStatus>
}

const BACKEND_CONFIG: Record<LocalLLMBackend, BackendConfig> = {
  ollama: {
    label: 'Ollama',
    statusCheck: (url) => window.api.ollamaCheckStatus({ baseUrl: url })
  },
  omlx: {
    label: 'oMLX',
    statusCheck: (url, key) => window.api.omlxCheckStatus({ baseUrl: url, apiKey: key })
  }
}

export { BACKEND_CONFIG }

// ── Hook ──

interface ConnectionTestResult {
  localStatus: OmlxExtendedStatus | OllamaStatus | null
  connectionTesting: boolean
  modelLoading: string | null
  testConnection: (
    activeBackend?: LocalLLMBackend,
    host?: string,
    port?: number
  ) => Promise<OllamaStatus | null>
  handleLoadOmlxModel: (modelId: string) => Promise<void>
  setLocalStatus: (s: OmlxExtendedStatus | OllamaStatus | null) => void
}

export function useLocalLLMConnectionTest(opts: {
  backend: LocalLLMBackend
  localHost: string
  localPort: number
  localApiKey: string
  provider: string
}): ConnectionTestResult {
  const addToast = useToastStore((s) => s.addToast)
  const [localStatus, setLocalStatus] = useState<OmlxExtendedStatus | OllamaStatus | null>(null)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  const testConnection = useCallback(
    async (
      activeBackend?: LocalLLMBackend,
      host?: string,
      port?: number
    ): Promise<OllamaStatus | null> => {
      setConnectionTesting(true)
      const b = activeBackend ?? opts.backend
      const h = host ?? opts.localHost
      const p = port ?? opts.localPort
      const config = BACKEND_CONFIG[b]
      try {
        const baseUrl = `http://${h}:${p}`
        const status = await config.statusCheck(baseUrl, opts.localApiKey || undefined)
        setLocalStatus(status)
        toastConnectionResult(addToast, config.label, status, h, p)
        return status
      } catch {
        const failStatus = { installed: false, running: false, models: [] }
        setLocalStatus(failStatus)
        addToast({
          message: `Connection failed — ${config.label} is not reachable at ${h}:${p}`,
          type: 'error'
        })
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [opts.backend, opts.localHost, opts.localPort, opts.localApiKey, addToast]
  )

  // Auto-test on mount when local-llm is already selected
  const [autoTestDone, setAutoTestDone] = useState(false)
  useEffect(() => {
    if (opts.provider === 'local-llm' && !autoTestDone) {
      setAutoTestDone(true)
      setConnectionTesting(true)
      const baseUrl = `http://${opts.localHost}:${opts.localPort}`
      const config = BACKEND_CONFIG[opts.backend]
      config
        .statusCheck(baseUrl, opts.localApiKey || undefined)
        .then((status) => setLocalStatus(status))
        .catch(() => setLocalStatus({ installed: false, running: false, models: [] }))
        .finally(() => setConnectionTesting(false))
    }
  }, [opts.provider, opts.backend, opts.localHost, opts.localPort, opts.localApiKey, autoTestDone])

  const handleLoadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${opts.localHost}:${opts.localPort}`
      try {
        await window.api.omlxLoadModel({
          modelId,
          baseUrl,
          apiKey: opts.localApiKey || undefined
        })
        addToast({ message: `Model "${modelId}" loaded successfully`, type: 'success' })
        await testConnection()
      } catch (err) {
        addToast({
          message: `Failed to load model: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error'
        })
      } finally {
        setModelLoading(null)
      }
    },
    [opts.localHost, opts.localPort, opts.localApiKey, testConnection, addToast]
  )

  return {
    localStatus,
    connectionTesting,
    modelLoading,
    testConnection,
    handleLoadOmlxModel,
    setLocalStatus
  }
}

// ── Toast helper ──

function toastConnectionResult(
  addToast: (t: { message: string; type: string }) => void,
  label: string,
  status: OllamaStatus | OmlxExtendedStatus,
  host: string,
  port: number
): void {
  if (status.running) {
    const modelCount = status.models.length
    addToast({
      message:
        modelCount > 0
          ? `Connected to ${label} — ${modelCount} model${modelCount !== 1 ? 's' : ''} available`
          : `Connected to ${label} — no models loaded yet`,
      type: modelCount > 0 ? 'success' : 'info'
    })
  } else if (status.installed) {
    addToast({
      message: `${label} is installed but not running. Start it and try again.`,
      type: 'error'
    })
  } else {
    addToast({
      message: `Could not reach ${label} at ${host}:${port}`,
      type: 'error'
    })
  }
}

import log from 'electron-log/main'
import type { OmlxModelDetail, OmlxExtendedStatus } from '../../shared/types'

/**
 * Service for checking oMLX server status and listing models.
 * oMLX uses OpenAI-compatible endpoints:
 *   - GET /v1/models → list loaded models
 *   - POST /v1/messages → Anthropic Messages API (used by SDK passthrough)
 *
 * Admin API (available since oMLX ~0.2):
 *   - GET /admin/api/models → list ALL models (downloaded + loaded)
 *   - POST /admin/api/models/{id}/load → load a model into memory
 *   - POST /admin/api/models/{id}/unload → unload a model from memory
 *
 * The admin API may require a Bearer token if the user has configured an API key.
 * We try admin API first and fall back to /v1/models on 401/503 for graceful degradation.
 */
class OmlxManagerService {
  private defaultBaseUrl = 'http://127.0.0.1:8000'

  private resolveBaseUrl(baseUrl?: string): string {
    return baseUrl ?? this.defaultBaseUrl
  }

  /**
   * Login to oMLX admin API and get session cookie for authenticated requests.
   * Returns the Set-Cookie header value, or undefined if login fails.
   */
  private async adminLogin(baseUrl: string, apiKey: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${baseUrl}/admin/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey }),
        signal: AbortSignal.timeout(5000),
        redirect: 'manual' // Don't follow redirects — we need the Set-Cookie
      })
      if (res.ok || res.status === 302) {
        const setCookie = res.headers.get('set-cookie')
        if (setCookie) {
          log.info('[OmlxManager] Admin login successful — session cookie obtained')
          return setCookie.split(';')[0] // e.g. "session=abc123"
        }
      }
      log.warn(`[OmlxManager] Admin login returned ${res.status}`)
    } catch (err) {
      log.warn('[OmlxManager] Admin login failed:', err)
    }
    return undefined
  }

  /**
   * Check oMLX server status — tries admin API first for richer model info,
   * falls back to /v1/models when admin API is unavailable (auth required, older version).
   * Returns OmlxExtendedStatus which extends OllamaStatus with optional allModels[].
   *
   * @param baseUrl — oMLX server URL (default http://127.0.0.1:8000)
   * @param apiKey — optional API key for authenticated oMLX instances
   */
  async checkStatus(baseUrl?: string, apiKey?: string): Promise<OmlxExtendedStatus> {
    const url = this.resolveBaseUrl(baseUrl)
    const status: OmlxExtendedStatus = {
      installed: false,
      running: false,
      models: []
    }

    try {
      // Build auth headers for admin API
      const adminHeaders: Record<string, string> = {}
      if (apiKey) {
        // Try cookie-based session auth first
        const sessionCookie = await this.adminLogin(url, apiKey)
        if (sessionCookie) {
          adminHeaders['Cookie'] = sessionCookie
        }
      }

      // Try admin API — returns ALL models (downloaded + loaded)
      const adminRes = await fetch(`${url}/admin/api/models`, {
        headers: adminHeaders,
        signal: AbortSignal.timeout(5000)
      })

      if (adminRes.ok) {
        status.installed = true
        status.running = true
        const data = (await adminRes.json()) as {
          models?: Array<{
            id: string
            loaded: boolean
            is_loading: boolean
            estimated_size_formatted: string
            pinned: boolean
            is_default: boolean
            model_type: string
          }>
        }
        const allModels = data.models ?? []
        // `models` field = loaded models only (backward compat with OllamaStatus)
        status.models = allModels.filter((m) => m.loaded).map((m) => m.id)
        // `allModels` = full list with loaded/downloading status
        status.allModels = allModels.map((m): OmlxModelDetail => ({
          id: m.id,
          loaded: m.loaded,
          isLoading: m.is_loading,
          estimatedSize: m.estimated_size_formatted,
          pinned: m.pinned,
          isDefault: m.is_default,
          modelType: m.model_type
        }))
        log.info(
          `[OmlxManager] Admin API: ${allModels.length} total, ` +
            `types: ${[...new Set(allModels.map((m) => m.model_type))].join(', ')}`
        )
        return status
      }

      // Admin API returned non-OK (401 auth required, 404 old version, etc.)
      // Fall back to /v1/models — but capture diagnostics for the UI
      log.warn(
        `[OmlxManager] Admin API ${adminRes.status} — ` +
          `${adminRes.status === 401 ? 'auth required (missing API key?)' : 'falling back to /v1/models'}`
      )
      status.diagnostics = {
        adminAuthRequired: adminRes.status === 401,
        adminHttpStatus: adminRes.status,
        timedOut: false,
        errorDetail:
          adminRes.status === 401
            ? apiKey
              ? 'API key rejected — check it in oMLX admin → Settings'
              : 'API key required — set it below to access model management'
            : undefined
      }
    } catch (err) {
      // Admin API not reachable — detect timeout vs connection refused
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      status.diagnostics = {
        adminAuthRequired: false,
        timedOut: isTimeout,
        errorDetail: isTimeout
          ? 'Admin API timed out — server may be overloaded or unreachable'
          : undefined
      }
    }

    try {
      // Bearer token auth for OpenAI-compatible endpoint
      const v1Headers: Record<string, string> = {}
      if (apiKey) {
        v1Headers['Authorization'] = `Bearer ${apiKey}`
      }

      const res = await fetch(`${url}/v1/models`, {
        headers: v1Headers,
        signal: AbortSignal.timeout(3000)
      })
      // Any HTTP response means the server is reachable
      status.installed = true
      status.running = true
      if (res.ok) {
        const data = (await res.json()) as {
          data?: { id: string }[]
        }
        status.models = (data.data ?? []).map((m) => m.id)

        // Synthesize allModels from /v1/models when admin API was unavailable
        // Use name-based heuristics to infer model type
        const EMBEDDING_PATTERN =
          /\b(bge|e5[-_]|gte[-_]|ember|embedding|nomic[-_]embed|mxbai[-_]embed|snowflake|modernbert)/i
        status.allModels = status.models.map((id) => ({
          id,
          loaded: true, // /v1/models only returns loaded models
          isLoading: false,
          estimatedSize: '',
          pinned: false,
          isDefault: false,
          modelType: EMBEDDING_PATTERN.test(id) ? 'embedding' : 'llm'
        }))
        log.info(
          `[OmlxManager] /v1/models fallback: ${status.models.length} loaded, ` +
            `synthesized types: ${status.allModels.map((m) => `${m.id}=${m.modelType}`).join(', ')}`
        )
      } else {
        log.warn(
          `[OmlxManager] /v1/models returned ${res.status} — server running but models unavailable`
        )
      }
    } catch (err) {
      // Not running — detect timeout vs connection refused for diagnostics
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      if (isTimeout) {
        status.diagnostics = {
          ...status.diagnostics,
          timedOut: true,
          errorDetail: `Server at ${url} timed out — check network connectivity`
        }
      }
      // Try to detect installation via PATH/app check
      try {
        const { execSync } = await import('node:child_process')
        // Check for oMLX CLI or .app bundle
        const result = execSync(
          'which omlx 2>/dev/null || (test -d "/Applications/oMLX.app" && echo "/Applications/oMLX.app")',
          { encoding: 'utf8', timeout: 3000, windowsHide: true }
        ).trim()
        if (result) {
          status.installed = true
        }
      } catch {
        // Not installed
      }
    }

    return status
  }

  /**
   * Guard against callers passing an absent model id. Without this,
   * `encodeURIComponent(undefined)` yields the literal string "undefined" and the
   * request still goes out as `/admin/api/models/undefined/load`, which 404s and
   * floods the oMLX server log.
   */
  private assertModelId(modelId: string, action: string): void {
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new Error(`Cannot ${action} model: modelId is required`)
    }
  }

  /**
   * Load a downloaded model into memory via the admin API.
   * Model loading can take 10-30s for large models, so we use a 60s timeout.
   */
  async loadModel(modelId: string, baseUrl?: string, apiKey?: string): Promise<void> {
    this.assertModelId(modelId, 'load')
    const url = this.resolveBaseUrl(baseUrl)
    log.info(`[OmlxManager] Loading model: ${modelId}`)

    // Authenticate for admin API
    const headers: Record<string, string> = {}
    if (apiKey) {
      const sessionCookie = await this.adminLogin(url, apiKey)
      if (sessionCookie) {
        headers['Cookie'] = sessionCookie
      }
    }

    const res = await fetch(`${url}/admin/api/models/${encodeURIComponent(modelId)}/load`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Failed to load model: ${res.status} ${text}`)
    }
    log.info(`[OmlxManager] Model loaded successfully: ${modelId}`)
  }

  /**
   * Unload a model from memory via the admin API.
   */
  async unloadModel(modelId: string, baseUrl?: string, apiKey?: string): Promise<void> {
    this.assertModelId(modelId, 'unload')
    const url = this.resolveBaseUrl(baseUrl)
    log.info(`[OmlxManager] Unloading model: ${modelId}`)

    // Authenticate for admin API
    const headers: Record<string, string> = {}
    if (apiKey) {
      const sessionCookie = await this.adminLogin(url, apiKey)
      if (sessionCookie) {
        headers['Cookie'] = sessionCookie
      }
    }

    const res = await fetch(`${url}/admin/api/models/${encodeURIComponent(modelId)}/unload`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Failed to unload model: ${res.status} ${text}`)
    }
    log.info(`[OmlxManager] Model unloaded successfully: ${modelId}`)
  }

  /**
   * Attempt to start oMLX automatically (macOS only).
   * Returns true if oMLX becomes responsive within ~8 seconds.
   */
  async startOmlx(): Promise<boolean> {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)

    try {
      await execAsync('open -a oMLX')

      // Wait up to 8 seconds for oMLX to become responsive
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const res = await fetch(`${this.defaultBaseUrl}/v1/models`, {
            signal: AbortSignal.timeout(1000)
          })
          if (res.ok) return true
        } catch {
          // Not ready yet
        }
      }
      return false
    } catch (error) {
      log.warn('[OmlxManager] Failed to start oMLX:', error)
      return false
    }
  }

  /** Get the admin dashboard URL for model management */
  getAdminUrl(baseUrl?: string): string {
    return `${this.resolveBaseUrl(baseUrl)}/admin`
  }
}

export const omlxManager = new OmlxManagerService()

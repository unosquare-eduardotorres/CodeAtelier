import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import type {
  ModelCapability,
  OllamaModelInfo,
  OllamaStatus,
  PullProgress
} from '../../shared/types'

/** One entry of /api/tags, reduced to the fields that say anything useful. */
export interface OllamaTagEntry {
  name: string
  digest: string
  family?: string
}

/**
 * Families that only ever produce embeddings. Deliberately one-directional:
 * a family we don't recognise proves nothing about chat capability, because
 * embedding models routinely share a base family with chat models
 * (EmbeddingGemma reports family 'gemma3'). Asserting chat from a non-bert
 * family would trade one confident lie for another.
 */
const EMBEDDING_FAMILIES = new Set(['bert', 'nomic-bert', 'nomic_bert', 'xlm-roberta'])

/** Last-resort match, used only when the server told us nothing. */
const EMBEDDING_NAME_PATTERN = /embed|bge|minilm|nomic|e5-|gte-|mxbai/i

/** Total wall-clock budget for the whole /api/show fan-out. */
const CAPABILITY_PROBE_BUDGET_MS = 3_000

/** Tier 1 — /api/show `capabilities`. Authoritative; absent on older Ollama. */
export function capabilityFromApiShow(capabilities?: string[] | null): ModelCapability | null {
  if (!capabilities || capabilities.length === 0) return null
  if (capabilities.includes('embedding')) return 'embedding'
  if (capabilities.includes('vision')) return 'vision'
  if (capabilities.includes('completion')) return 'chat'
  return null
}

/** Tier 2 — `details.family` from /api/tags. Only ever resolves embedding. */
export function capabilityFromFamily(family?: string): ModelCapability | null {
  if (!family) return null
  return EMBEDDING_FAMILIES.has(family.toLowerCase()) ? 'embedding' : null
}

/** Tier 3 — the model's name. Always tagged 'name-heuristic' so the UI hedges. */
export function capabilityFromName(name: string): ModelCapability {
  return EMBEDDING_NAME_PATTERN.test(name) ? 'embedding' : 'chat'
}

/**
 * Singleton service for managing Ollama — detect installation, pull models
 * with streaming progress, generate embeddings, and health-check.
 *
 * Uses native fetch() (Node 24 built-in) — no extra dependencies.
 *
 * Events:
 * - 'pullProgress': PullProgress — streaming download progress
 * - 'pullComplete': string — model name when pull finishes
 * - 'pullError': string — error message on pull failure
 */
class OllamaManagerService extends EventEmitter {
  private defaultBaseUrl = 'http://127.0.0.1:11434'
  // SVC-13: Per-model abort controllers to prevent concurrent pulls from cancelling the wrong model
  private readonly pullControllers = new Map<string, AbortController>()
  /**
   * Authoritative capabilities only, keyed `${baseUrl}::${name}::${digest}`.
   * The digest changes when a tag is re-pulled, so a re-pulled model is
   * re-probed rather than answered from a stale entry.
   */
  private readonly capabilityCache = new Map<string, OllamaModelInfo>()

  /** Build the base URL from host:port or use provided URL */
  private resolveBaseUrl(baseUrl?: string): string {
    return baseUrl ?? this.defaultBaseUrl
  }

  /** Check if an address is a remote (non-localhost) Ollama */
  isRemote(host: string): boolean {
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
  }

  /**
   * Check the current status of the Ollama installation.
   * Detects whether Ollama is installed, running, its version, and available models.
   *
   * @param baseUrl - Optional Ollama server URL (e.g. 'http://192.168.1.50:11434')
   */
  async checkStatus(baseUrl?: string): Promise<OllamaStatus> {
    const url = this.resolveBaseUrl(baseUrl)
    const status: OllamaStatus = {
      installed: false,
      running: false,
      models: []
    }

    try {
      // Check if Ollama is running by hitting the version endpoint
      const versionRes = await fetch(`${url}/api/version`, {
        signal: AbortSignal.timeout(3000)
      })
      if (versionRes.ok) {
        const data = (await versionRes.json()) as { version?: string }
        status.installed = true
        status.running = true
        status.version = data.version
      }
    } catch {
      // Ollama is not running or not installed
      // Try to detect installation via PATH check (only for local servers)
      if (!this.isRemote(new URL(url).hostname)) {
        try {
          const { execSync } = await import('node:child_process')
          const result = execSync('which ollama 2>/dev/null || where ollama 2>NUL', {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true
          }).trim()
          if (result) {
            status.installed = true
          }
        } catch {
          // Not installed
        }
      }
      return status
    }

    // If running, also get the list of available models
    try {
      const tagsRes = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      })
      if (tagsRes.ok) {
        const data = (await tagsRes.json()) as {
          models?: { name: string; digest?: string; details?: { family?: string } }[]
        }
        // `details.family` arrives free in this response and is the only type
        // signal /api/tags carries — dropping it is what left the UI guessing.
        const tags: OllamaTagEntry[] = (data.models ?? []).map((m) => ({
          name: m.name,
          digest: m.digest ?? '',
          family: m.details?.family
        }))
        status.models = tags.map((t) => t.name)
        try {
          status.modelDetails = await this.classifyModels(tags, url)
        } catch (error) {
          // Capability detection is advisory — never fail a status check over it
          log.warn('[OllamaManager] Capability detection failed:', error)
        }
      }
    } catch (error) {
      log.warn('[OllamaManager] Failed to fetch model tags:', error)
    }

    return status
  }

  /**
   * Ask Ollama what a model can do. Returns null on anything other than a
   * successful response carrying `capabilities` — including 404s from Ollama
   * versions that predate the field, which is the normal case, not an error.
   */
  private async showModel(
    model: string,
    baseUrl: string,
    signal: AbortSignal
  ): Promise<string[] | null> {
    try {
      const res = await fetch(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal
      })
      if (!res.ok) return null
      const data = (await res.json()) as { capabilities?: string[] }
      return data.capabilities ?? null
    } catch {
      // Timed out, aborted by the shared budget, or unparseable — fall through
      return null
    }
  }

  /**
   * Resolve each model's capability through the three-tier chain.
   *
   * /api/show is one request per model, so the fan-out is issued in parallel
   * under a single shared budget: a slow server degrades every model to tiers
   * 2–3 at once rather than serialising 40 timeouts.
   */
  async classifyModels(tags: OllamaTagEntry[], baseUrl?: string): Promise<OllamaModelInfo[]> {
    const url = this.resolveBaseUrl(baseUrl)
    if (tags.length === 0) return []
    const budget = AbortSignal.timeout(CAPABILITY_PROBE_BUDGET_MS)

    return Promise.all(
      tags.map(async (tag): Promise<OllamaModelInfo> => {
        const key = `${url}::${tag.name}::${tag.digest}`
        const cached = this.capabilityCache.get(key)
        if (cached) return cached

        const info = await this.classifyOne(tag, url, budget)
        // Only authoritative answers are cached. Caching a name-based guess made
        // during a timeout would pin that guess for the rest of the process,
        // long after the server became reachable again.
        if (info.detectedVia !== 'name-heuristic') {
          this.capabilityCache.set(key, info)
        }
        return info
      })
    )
  }

  private async classifyOne(
    tag: OllamaTagEntry,
    baseUrl: string,
    budget: AbortSignal
  ): Promise<OllamaModelInfo> {
    const base = { name: tag.name, digest: tag.digest, family: tag.family }

    const fromShow = capabilityFromApiShow(await this.showModel(tag.name, baseUrl, budget))
    if (fromShow) return { ...base, capability: fromShow, detectedVia: 'api-show' }

    const fromFamily = capabilityFromFamily(tag.family)
    if (fromFamily) return { ...base, capability: fromFamily, detectedVia: 'family' }

    return { ...base, capability: capabilityFromName(tag.name), detectedVia: 'name-heuristic' }
  }

  /** Drop cached capabilities — exposed for tests and after a model removal. */
  clearCapabilityCache(): void {
    this.capabilityCache.clear()
  }

  /**
   * Pull (download) a model from the Ollama registry.
   * Streams NDJSON progress events and emits 'pullProgress' for each update.
   *
   * @param model - The model tag to pull
   * @param baseUrl - Optional Ollama server URL for remote servers
   */
  async pullModel(model: string, baseUrl?: string): Promise<void> {
    const url = this.resolveBaseUrl(baseUrl)
    const controller = new AbortController()
    this.pullControllers.set(model, controller)

    log.info(`[OllamaManager] Pulling model: ${model} from ${url}`)

    try {
      const res = await fetch(`${url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
        signal: controller.signal
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Pull failed (${res.status}): ${errorText}`)
      }

      if (!res.body) {
        throw new Error('No response body for pull stream')
      }

      // Stream NDJSON response
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line) as {
              status?: string
              completed?: number
              total?: number
              error?: string
            }

            if (data.error) {
              this.emit('pullError', data.error)
              log.error(`[OllamaManager] Pull error: ${data.error}`)
              return
            }

            const progress: PullProgress = {
              model,
              status: data.status ?? '',
              completed: data.completed ?? 0,
              total: data.total ?? 0,
              percent: data.total ? Math.round(((data.completed ?? 0) / data.total) * 100) : 0
            }
            this.emit('pullProgress', progress)
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      this.emit('pullComplete', model)
      log.info(`[OllamaManager] Pull complete: ${model}`)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        log.info(`[OllamaManager] Pull cancelled: ${model}`)
        this.emit('pullError', 'Pull cancelled')
        return
      }
      const message = (error as Error).message
      log.error(`[OllamaManager] Pull failed: ${message}`)
      this.emit('pullError', message)
      throw error
    } finally {
      this.pullControllers.delete(model)
    }
  }

  /**
   * Cancel an in-progress model pull.
   * @param model - Optional: cancel a specific model pull. If omitted, cancels all.
   */
  cancelPull(model?: string): void {
    if (model) {
      const controller = this.pullControllers.get(model)
      if (controller) {
        controller.abort()
        this.pullControllers.delete(model)
        log.info(`[OllamaManager] Pull cancelled for model: ${model}`)
      }
    } else {
      for (const [m, c] of this.pullControllers) {
        c.abort()
        log.info(`[OllamaManager] Pull cancelled for model: ${m}`)
      }
      this.pullControllers.clear()
    }
  }

  /**
   * Remove a model from Ollama.
   *
   * @param model - The model tag to remove
   * @param baseUrl - Optional Ollama server URL for remote servers
   */
  async removeModel(model: string, baseUrl?: string): Promise<void> {
    const url = this.resolveBaseUrl(baseUrl)
    log.info(`[OllamaManager] Removing model: ${model} from ${url}`)

    // OC-06: Add timeout to prevent indefinite hang (matches embed() pattern)
    const res = await fetch(`${url}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(30_000)
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Failed to remove model (${res.status}): ${errorText}`)
    }

    log.info(`[OllamaManager] Model removed: ${model}`)
  }

  /**
   * Generate embeddings for a batch of inputs.
   * Ollama supports batch embedding natively.
   *
   * @param model - The embedding model to use
   * @param input - Array of strings to embed
   * @param baseUrl - Optional Ollama server URL for remote servers
   */
  async embed(model: string, input: string[], baseUrl?: string): Promise<number[][]> {
    const url = this.resolveBaseUrl(baseUrl)
    // SVC-14: Add timeout to prevent indefinite hangs if Ollama is unresponsive
    const res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(30_000) // 30s for embedding operations
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Embed failed (${res.status}): ${errorText}`)
    }

    const data = (await res.json()) as { embeddings: number[][] }
    return data.embeddings
  }

  /**
   * Attempt to start Ollama automatically (platform-aware).
   * Returns true if Ollama becomes responsive within ~8 seconds.
   */
  async startOllama(): Promise<boolean> {
    const { spawn } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { exec } = await import('node:child_process')
    const execAsync = promisify(exec)

    try {
      if (process.platform === 'darwin') {
        // macOS: open the Ollama app (which starts the server)
        await execAsync('open -a Ollama')
      } else if (process.platform === 'win32') {
        // SVC-17: Use spawn with error handler instead of fire-and-forget exec
        // No `detached` on Windows: DETACHED_PROCESS makes the OS ignore
        // CREATE_NO_WINDOW (nodejs/node#21825), so the console would flash.
        // Children already outlive the parent on Windows; unref() detaches the
        // event loop reference.
        const child = spawn('ollama', ['serve'], {
          stdio: 'ignore',
          windowsHide: true
        })
        child.on('error', (err) => {
          log.warn('[OllamaManager] Failed to spawn ollama serve (Windows):', err)
        })
        child.unref()
      } else {
        // SVC-17: Use spawn with error handler instead of fire-and-forget exec
        const child = spawn('ollama', ['serve'], {
          detached: true,
          stdio: 'ignore'
        })
        child.on('error', (err) => {
          log.warn('[OllamaManager] Failed to spawn ollama serve (Linux):', err)
        })
        child.unref()
      }

      // Wait up to 8 seconds for Ollama to become responsive
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const res = await fetch(`${this.defaultBaseUrl}/api/version`, {
            signal: AbortSignal.timeout(1000)
          })
          if (res.ok) return true
        } catch {
          // Not ready yet
        }
      }
      return false
    } catch (error) {
      log.warn('[OllamaManager] Failed to start Ollama:', error)
      return false
    }
  }
}

export const ollamaManager = new OllamaManagerService()

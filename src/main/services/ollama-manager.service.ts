import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import type { OllamaStatus, PullProgress } from '../../shared/types'

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
            timeout: 3000
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
        const data = (await tagsRes.json()) as { models?: { name: string }[] }
        status.models = (data.models ?? []).map((m) => m.name)
      }
    } catch (error) {
      log.warn('[OllamaManager] Failed to fetch model tags:', error)
    }

    return status
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
        const child = spawn('ollama', ['serve'], {
          detached: true,
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

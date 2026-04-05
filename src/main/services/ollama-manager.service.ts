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
  private baseUrl = 'http://127.0.0.1:11434'
  private pullAbortController: AbortController | null = null

  /**
   * Check the current status of the Ollama installation.
   * Detects whether Ollama is installed, running, its version, and available models.
   */
  async checkStatus(): Promise<OllamaStatus> {
    const status: OllamaStatus = {
      installed: false,
      running: false,
      models: []
    }

    try {
      // Check if Ollama is running by hitting the version endpoint
      const versionRes = await fetch(`${this.baseUrl}/api/version`, {
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
      // Try to detect installation via PATH check
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
      return status
    }

    // If running, also get the list of available models
    try {
      const tagsRes = await fetch(`${this.baseUrl}/api/tags`, {
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
   */
  async pullModel(model: string): Promise<void> {
    this.pullAbortController = new AbortController()

    log.info(`[OllamaManager] Pulling model: ${model}`)

    try {
      const res = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
        signal: this.pullAbortController.signal
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
      this.pullAbortController = null
    }
  }

  /**
   * Cancel an in-progress model pull.
   */
  cancelPull(): void {
    if (this.pullAbortController) {
      this.pullAbortController.abort()
      this.pullAbortController = null
      log.info('[OllamaManager] Pull cancelled by user')
    }
  }

  /**
   * Remove a model from Ollama.
   */
  async removeModel(model: string): Promise<void> {
    log.info(`[OllamaManager] Removing model: ${model}`)

    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model })
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
   */
  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input })
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
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)

    try {
      if (process.platform === 'darwin') {
        // macOS: open the Ollama app (which starts the server)
        await execAsync('open -a Ollama')
      } else if (process.platform === 'win32') {
        // Windows: try starting ollama serve in background
        exec('start /B ollama serve', { windowsHide: true })
      } else {
        // Linux: start ollama serve in background
        exec('nohup ollama serve > /dev/null 2>&1 &')
      }

      // Wait up to 8 seconds for Ollama to become responsive
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const res = await fetch(`${this.baseUrl}/api/version`, {
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

  /**
   * Check if a specific model is available locally.
   */
  async isModelAvailable(model: string): Promise<boolean> {
    try {
      const status = await this.checkStatus()
      if (!status.running) return false
      // Normalize: Ollama may return "model:latest" vs "model"
      return status.models.some(
        (m) => m === model || m === `${model}:latest` || m.startsWith(`${model}:`)
      )
    } catch {
      return false
    }
  }
}

export const ollamaManager = new OllamaManagerService()

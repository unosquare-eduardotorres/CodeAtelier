import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { LLAMAFILE_EMBEDDING } from '../../shared/constants'
import type { EmbeddingDownloadPhase } from '../../shared/types'

/**
 * Downloads + verifies the llamafile embedding sidecar artefacts:
 *   1. the llamafile **engine binary** (pinned GitHub release asset), and
 *   2. the **GGUF embedding model** (pinned Hugging Face file).
 *
 * Both are fetched on first use (not bundled) into the user-data directory:
 *   - engine → `userData/llamafile/<asset>[.exe]`
 *   - model  → `userData/models/gguf/<file>`
 *
 * Integrity: every download is streamed to a `.part` temp file while a running
 * SHA-256 is computed; the file is only promoted to its final name once the
 * hash + byte-size match the pinned values. The engine binary is then made
 * executable (`chmod 0o755`) and, on macOS, the Gatekeeper quarantine xattr is
 * stripped so the app can `spawn()` it.
 *
 * Events:
 * - `modelDownloadProgress` — `{ progress, loaded, total, phase }`
 *     where `phase` is `'binary'` (engine) or `'model'` (GGUF).
 */
class LlamafileDownloadService extends EventEmitter {
  private _userDataDir: string | null = null

  /** Lazily resolve user-data dir — deferred so the module imports outside Electron. */
  private get userDataDir(): string {
    if (!this._userDataDir) {
      // Standalone node processes (e.g. MCP server) pass userData via DB_PATH.
      this._userDataDir = process.env.DB_PATH ?? app.getPath('userData')
    }
    return this._userDataDir
  }

  /** Absolute path to the engine binary (with `.exe` on Windows). */
  get binaryPath(): string {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return path.join(this.userDataDir, 'llamafile', `${LLAMAFILE_EMBEDDING.engine.asset}${ext}`)
  }

  /** Absolute path to the GGUF model file. */
  get modelPath(): string {
    return path.join(this.userDataDir, 'models', 'gguf', LLAMAFILE_EMBEDDING.model.file)
  }

  /** Engine binary exists on disk with the expected byte size. */
  isEngineInstalled(): boolean {
    return this.fileSizeMatches(this.binaryPath, LLAMAFILE_EMBEDDING.engine.sizeBytes)
  }

  /** GGUF model exists on disk with the expected byte size. */
  isModelInstalled(): boolean {
    return this.fileSizeMatches(this.modelPath, LLAMAFILE_EMBEDDING.model.sizeBytes)
  }

  /**
   * Ensure both the engine binary and the model are downloaded + verified.
   * Idempotent: skips artefacts already present with the correct size.
   */
  async ensureInstalled(): Promise<void> {
    if (!this.isEngineInstalled()) {
      log.info('[LlamafileDownload] Engine binary missing — downloading…')
      await this.downloadFile(
        LLAMAFILE_EMBEDDING.engine.url,
        this.binaryPath,
        LLAMAFILE_EMBEDDING.engine.sha256,
        LLAMAFILE_EMBEDDING.engine.sizeBytes,
        'binary'
      )
      log.info(`[LlamafileDownload] Engine ready: ${this.binaryPath}`)
    }

    if (!this.isModelInstalled()) {
      log.info('[LlamafileDownload] GGUF model missing — downloading…')
      await this.downloadFile(
        LLAMAFILE_EMBEDDING.model.url,
        this.modelPath,
        LLAMAFILE_EMBEDDING.model.sha256,
        LLAMAFILE_EMBEDDING.model.sizeBytes,
        'model'
      )
      log.info(`[LlamafileDownload] Model ready: ${this.modelPath}`)
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private fileSizeMatches(filePath: string, expectedSize: number): boolean {
    try {
      return existsSync(filePath) && statSync(filePath).size === expectedSize
    } catch {
      return false
    }
  }

  /**
   * Stream a URL to disk, computing SHA-256 as bytes arrive, and only promote
   * the `.part` temp file to its final name when hash + size match the pins.
   */
  private async downloadFile(
    url: string,
    destPath: string,
    expectedSha: string,
    expectedSize: number,
    phase: EmbeddingDownloadPhase
  ): Promise<void> {
    // HTTPS-only — never download a binary over plaintext.
    if (!url.startsWith('https://')) {
      throw new Error(`Refusing to download over non-HTTPS URL: ${url}`)
    }

    mkdirSync(path.dirname(destPath), { recursive: true })
    const tmpPath = `${destPath}.part`
    // Clear any stale partial from a previous aborted attempt.
    rmSync(tmpPath, { force: true })

    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`)
    }

    const total = Number(res.headers.get('content-length')) || expectedSize
    const hash = createHash('sha256')
    let loaded = 0
    let lastEmitPct = -1

    const out = createWriteStream(tmpPath)
    // Record + swallow stream errors (e.g. disk full) so an IO failure rejects
    // cleanly instead of crashing the process with an unhandled 'error' event.
    let streamError: Error | undefined
    out.on('error', (e: Error) => {
      streamError ??= e
    })

    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        hash.update(chunk)
        loaded += chunk.length
        // Await each write: applies backpressure (no memory balloon) and rejects
        // on a write failure.
        await new Promise<void>((resolve, reject) => {
          out.write(chunk, (err) => (err ? reject(err) : resolve()))
        })

        const pct = total > 0 ? Math.floor((loaded / total) * 100) : 0
        if (pct !== lastEmitPct) {
          lastEmitPct = pct
          this.emit('modelDownloadProgress', { progress: pct, loaded, total, phase })
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
      if (streamError) throw streamError
    } catch (err) {
      out.destroy()
      rmSync(tmpPath, { force: true })
      throw err
    }

    // ── Integrity gate ──────────────────────────────────────────────────────
    const actualSize = statSync(tmpPath).size
    const actualSha = hash.digest('hex')
    if (actualSize !== expectedSize) {
      rmSync(tmpPath, { force: true })
      throw new Error(
        `Size mismatch for ${phase}: expected ${expectedSize} bytes, got ${actualSize}`
      )
    }
    if (actualSha !== expectedSha) {
      rmSync(tmpPath, { force: true })
      throw new Error(`SHA-256 mismatch for ${phase}: expected ${expectedSha}, got ${actualSha}`)
    }

    // Make the engine runnable BEFORE the atomic rename, so the "installed"
    // signal (final name present + size match) is never observed for a
    // non-executable/quarantined binary. If the app is killed mid-install, the
    // next launch either re-downloads (no final file) or finds a runnable one.
    if (phase === 'binary') {
      await this.prepareBinary(tmpPath)
    }

    renameSync(tmpPath, destPath)
    // Ensure a final 100% tick even if content-length was absent/short.
    this.emit('modelDownloadProgress', {
      progress: 100,
      loaded: expectedSize,
      total: expectedSize,
      phase
    })
  }

  /**
   * Make the downloaded engine binary runnable: executable bit on POSIX, and
   * strip the macOS quarantine xattr so Gatekeeper allows `spawn()`.
   * Only runs after the SHA-256 gate has passed.
   */
  private async prepareBinary(binaryPath: string): Promise<void> {
    if (process.platform !== 'win32') {
      await chmod(binaryPath, 0o755)
    }
    if (process.platform === 'darwin') {
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', binaryPath])
      } catch {
        // xattr absent or attribute not set — non-fatal.
      }
    }
  }
}

export const llamafileDownloadService = new LlamafileDownloadService()

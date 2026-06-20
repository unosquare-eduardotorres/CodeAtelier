import log from 'electron-log/main'
import { safeStorage } from 'electron'
import { workspaceRepository } from '../db/repositories'

type AuthMode = 'claude-max' | 'api-key'

export interface AuthProvider {
  mode: AuthMode
  getApiKey(): string | undefined
  supportsSDK(): boolean
}

class AuthProviderService implements AuthProvider {
  private _mode: AuthMode = 'claude-max'
  private _apiKey: string | undefined

  get mode(): AuthMode {
    return this._mode
  }

  getApiKey(): string | undefined {
    return this._apiKey
  }

  supportsSDK(): boolean {
    // SDK is now the only execution path — works with both claude-max (CLI auth) and api-key
    return true
  }

  /** Load auth settings from workspace settings or environment */
  loadFromWorkspace(workspacePath: string): void {
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const authMode = (settings?.authMode as AuthMode) ?? 'claude-max'
    this._mode = authMode

    if (authMode === 'api-key') {
      // IPC-01: Decrypt API key from safeStorage if encrypted, support legacy plaintext
      const storedKey = settings?.anthropicApiKey as string | undefined
      const isEncrypted = settings?.anthropicApiKeyEncrypted as boolean | undefined

      if (storedKey && isEncrypted) {
        try {
          this._apiKey = safeStorage.decryptString(Buffer.from(storedKey, 'base64'))
        } catch (err) {
          log.scope('AuthProvider').error('Failed to decrypt API key:', err)
          this._apiKey = undefined
        }
      } else if (storedKey) {
        // Legacy plaintext path — will be re-encrypted on next auth update
        this._apiKey = storedKey
      } else {
        // Fall back to env var
        this._apiKey = process.env.ANTHROPIC_API_KEY
      }
    } else {
      this._apiKey = undefined
    }

    log.scope('AuthProvider').info(`Auth mode: ${this._mode}, SDK supported: ${this.supportsSDK()}`)
  }

  /** Update auth mode programmatically */
  setAuthMode(mode: AuthMode, apiKey?: string): void {
    this._mode = mode
    this._apiKey = apiKey
  }
}

export const authProvider = new AuthProviderService()

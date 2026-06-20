import log from 'electron-log/main'
import { workspaceRepository } from '../db/repositories'
import { decryptSettingsKey } from '../ipc/encrypt-settings-keys'

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
      // Prefer workspace-level setting, fall back to env var
      // SEC-04: Decrypt API key (handles both legacy plaintext and encrypted)
      const storedKey = decryptSettingsKey(
        settings?.anthropicApiKey as string | undefined,
        !!settings?.anthropicApiKeyEncrypted
      )
      this._apiKey = storedKey ?? process.env.ANTHROPIC_API_KEY
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

import { useState, useEffect } from 'react'
import { Key, Loader2, Check, AlertCircle } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'

type AuthMode = 'claude-max' | 'api-key'

export default function AuthSettingsTab(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const [authMode, setAuthMode] = useState<AuthMode>('claude-max')
  const [apiKey, setApiKey] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  // Load existing settings on mount
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        const mode = (settings?.authMode as AuthMode) ?? 'claude-max'
        setAuthMode(mode)
        if (mode === 'api-key' && settings?.anthropicApiKey) {
          setApiKey(settings.anthropicApiKey as string)
        }
      })
      .catch(() => {
        // Settings unavailable — use defaults
      })
  }, [activeWorkspace])

  const handleSave = async (): Promise<void> => {
    if (!activeWorkspace) return

    if (authMode === 'api-key' && !apiKey.trim()) {
      setSaveStatus('error')
      setErrorMessage('API key is required when using API Key mode')
      return
    }

    setIsSaving(true)
    setSaveStatus('idle')
    setErrorMessage('')

    try {
      await window.api.updateAuthSettings({
        workspaceId: activeWorkspace.id,
        authMode,
        anthropicApiKey: authMode === 'api-key' ? apiKey.trim() : undefined
      })
      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch (error) {
      setSaveStatus('error')
      setErrorMessage((error as Error).message || 'Failed to save auth settings')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-xl">
      <div className="flex items-center gap-2 mb-6">
        <Key size={18} className="text-amber-400" />
        <h2 className="text-base font-semibold text-text-primary">Authentication</h2>
      </div>

      <p className="text-sm text-text-secondary mb-6">
        Choose how Agent Studio authenticates with Claude. The default uses your Claude Max
        subscription via CLI. Alternatively, provide an API key to use the Agent SDK for improved
        streaming and reliability.
      </p>

      {/* Auth mode selection */}
      <div className="space-y-3 mb-6">
        <label className="flex items-start gap-3 p-3 rounded-lg border border-border-subtle hover:border-border-default transition-colors cursor-pointer">
          <input
            type="radio"
            name="authMode"
            value="claude-max"
            checked={authMode === 'claude-max'}
            onChange={() => setAuthMode('claude-max')}
            className="mt-0.5 accent-primary"
          />
          <div>
            <span className="text-sm font-medium text-text-primary">Claude Max (CLI)</span>
            <p className="text-xs text-text-secondary mt-0.5">
              Uses your Claude Max subscription via the Claude CLI. No API key needed.
            </p>
          </div>
        </label>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-border-subtle hover:border-border-default transition-colors cursor-pointer">
          <input
            type="radio"
            name="authMode"
            value="api-key"
            checked={authMode === 'api-key'}
            onChange={() => setAuthMode('api-key')}
            className="mt-0.5 accent-primary"
          />
          <div>
            <span className="text-sm font-medium text-text-primary">API Key (Agent SDK)</span>
            <p className="text-xs text-text-secondary mt-0.5">
              Uses the Anthropic API directly via Agent SDK. Enables improved streaming, typed
              hooks, and eliminates NDJSON parsing.
            </p>
          </div>
        </label>
      </div>

      {/* API key input (conditional) */}
      {authMode === 'api-key' && (
        <div className="mb-6">
          <label
            htmlFor="api-key-input"
            className="block text-sm font-medium text-text-primary mb-1.5"
          >
            Anthropic API Key
          </label>
          <input
            id="api-key-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-surface-overlay text-text-primary text-sm placeholder:text-text-tertiary focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
          />
          <p className="text-xs text-text-secondary mt-1.5">
            Your API key is stored locally in the workspace settings database. It is never sent to
            any server other than the Anthropic API.
          </p>
        </div>
      )}

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          Save
        </button>

        {saveStatus === 'success' && (
          <span className="text-sm text-green-400 flex items-center gap-1">
            <Check size={14} />
            Saved
          </span>
        )}

        {saveStatus === 'error' && (
          <span className="text-sm text-red-400 flex items-center gap-1">
            <AlertCircle size={14} />
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  )
}

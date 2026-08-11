import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Eye, EyeOff, Check, AlertTriangle, Loader2, Trash2, Plug } from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'
import type {
  IntegrationConnectionResult,
  IntegrationCredentialStatus
} from '../../../../../shared/integration-credentials.types'
import { isFieldVisible } from '../../../../../shared/integration-credentials.types'

/** Extra guidance shown under a failed connection test, keyed by result code. */
const CODE_HINTS: Record<string, string> = {
  'auth-failed': 'Tokens expire. Generate a fresh one and paste it again.',
  'not-found':
    'Double-check the URL — on-prem installs often live under a context path such as /jira.',
  cert: 'Ask IT for the internal root CA, install it in the OS trust store, then retry.',
  proxy: 'Connect to the VPN (or check your proxy settings) and try again.',
  timeout: 'The host accepted the connection but never answered — usually a VPN or firewall issue.'
}

/**
 * Registry-driven credential form. Renders whatever `credentialFields` declares,
 * so a new integration needs no new UI code.
 *
 * Secrets are write-only: the stored value is never sent to the renderer, and an
 * empty secret field on submit means "leave unchanged".
 */
export default function IntegrationCredentialsForm({
  integration,
  workspaceId,
  onStatusChange,
  onCleared
}: {
  integration: ExternalMcpDefinition
  workspaceId: string
  onStatusChange?: (status: IntegrationCredentialStatus) => void
  /** Clearing also disables the integration for the workspace — lets the page re-read settings. */
  onCleared?: () => void
}): React.JSX.Element | null {
  const fields = integration.credentialFields
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<IntegrationCredentialStatus | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testResult, setTestResult] = useState<IntegrationConnectionResult | null>(null)

  // Held in a ref so `applyStatus` keeps a stable identity: the parent passes a
  // fresh closure on every render, and an unstable callback in the load effect's
  // dep array would re-fire the status IPC in an unbounded loop.
  const onStatusChangeRef = useRef(onStatusChange)
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  const applyStatus = useCallback((next: IntegrationCredentialStatus) => {
    setStatus(next)
    onStatusChangeRef.current?.(next)
  }, [])

  // Load stored (non-secret) values + filled-state
  useEffect(() => {
    if (!integration.credentialFields?.length) return
    window.api
      .getIntegrationCredentialStatus({ workspaceId, integrationId: integration.id })
      .then((next) => {
        applyStatus(next)
        setValues((prev) => ({ ...next.values, ...prev }))
      })
      .catch((err) =>
        console.warn('[IntegrationCredentialsForm] Non-fatal: status load failed:', err)
      )
  }, [workspaceId, integration.id, integration.credentialFields, applyStatus])

  const visibleFields = useMemo(
    () => (fields ?? []).filter((field) => isFieldVisible(field, values)),
    [fields, values]
  )

  const setValue = (key: string, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
    setTestResult(null)
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.api.saveIntegrationCredentials({
        workspaceId,
        integrationId: integration.id,
        values
      })
      applyStatus(next)
      // Drop secret drafts — they are stored now and must not linger in state.
      setValues((prev) => {
        const cleaned = { ...prev }
        for (const field of fields ?? []) if (field.secret) delete cleaned[field.key]
        return cleaned
      })
      setSaved(true)
    } catch (err) {
      console.error('[IntegrationCredentialsForm] Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(
        await window.api.testIntegrationConnection({
          workspaceId,
          integrationId: integration.id,
          values
        })
      )
    } catch (err) {
      setTestResult({
        ok: false,
        code: 'network',
        message: err instanceof Error ? err.message : 'Connection test failed'
      })
    } finally {
      setTesting(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    await window.api.clearIntegrationCredentials({ workspaceId, integrationId: integration.id })
    const next = await window.api.getIntegrationCredentialStatus({
      workspaceId,
      integrationId: integration.id
    })
    applyStatus(next)
    setValues({})
    setTestResult(null)
    setSaved(false)
    onCleared?.()
  }

  if (!fields || fields.length === 0) return null

  return (
    <div
      data-testid="integration-credentials-form"
      className="bg-surface-base border border-border-subtle rounded-md p-3 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h5 className="text-xs font-semibold text-text-primary">Credentials</h5>
        {status?.configured && (
          <span className="inline-flex items-center gap-1 text-[11px] text-success">
            <Check size={10} /> Configured
          </span>
        )}
      </div>

      {visibleFields.map((field) => {
        const isFilled = status?.filledKeys.includes(field.key) ?? false
        const showSecret = revealed[field.key] === true

        return (
          <div key={field.key} className="space-y-1">
            <label
              htmlFor={`cred-${integration.id}-${field.key}`}
              className="block text-[11px] font-medium text-text-secondary"
            >
              {field.label}
              {field.required && <span className="text-warning ml-0.5">*</span>}
            </label>

            {field.type === 'select' ? (
              <select
                id={`cred-${integration.id}-${field.key}`}
                value={values[field.key] ?? ''}
                onChange={(e) => setValue(field.key, e.target.value)}
                className="w-full bg-surface-overlay border border-border-default rounded px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="">Select…</option>
                {field.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="relative">
                <input
                  id={`cred-${integration.id}-${field.key}`}
                  type={field.secret && !showSecret ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValue(field.key, e.target.value)}
                  placeholder={
                    field.secret && isFilled ? '•••••••• (leave blank to keep)' : field.placeholder
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-surface-overlay border border-border-default rounded px-2 py-1.5 text-xs text-text-primary font-mono pr-8"
                />
                {field.secret && (
                  <button
                    type="button"
                    onClick={() =>
                      setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    title={showSecret ? 'Hide' : 'Reveal'}
                  >
                    {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                )}
              </div>
            )}

            {/* Description of the selected option, then the field's own help text */}
            {field.type === 'select' &&
              field.options?.find((o) => o.value === values[field.key])?.description && (
                <p className="text-[10px] text-text-muted">
                  {field.options.find((o) => o.value === values[field.key])!.description}
                </p>
              )}
            {field.help && <p className="text-[10px] text-text-muted">{field.help}</p>}
          </div>
        )
      })}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-2.5 py-1 rounded bg-accent text-white text-[11px] font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>

        {integration.supportsConnectionTest && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-border-default text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {testing ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        )}

        {(status?.filledKeys.length ?? 0) > 0 && (
          <button
            onClick={handleClear}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-muted hover:text-warning ml-auto"
            title="Remove stored credentials"
          >
            <Trash2 size={11} /> Clear
          </button>
        )}
      </div>

      {/* Connection test result */}
      {testResult && (
        <div
          data-testid="connection-test-result"
          className={`flex items-start gap-2 rounded-md p-2 text-[11px] ${
            testResult.ok
              ? 'bg-success-muted border border-success/20 text-text-secondary'
              : 'bg-warning-muted border border-warning/20 text-text-secondary'
          }`}
        >
          {testResult.ok ? (
            <Check size={12} className="text-success mt-0.5 flex-shrink-0" />
          ) : (
            <AlertTriangle size={12} className="text-warning mt-0.5 flex-shrink-0" />
          )}
          <div>
            <p>{testResult.message}</p>
            {!testResult.ok && testResult.code && CODE_HINTS[testResult.code] && (
              <p className="text-text-muted mt-0.5">{CODE_HINTS[testResult.code]}</p>
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-text-muted">
        Stored per workspace and encrypted with your OS keychain. Any of these values can also be
        set as environment variables ({integration.envKeys?.slice(0, 3).join(', ')}…) if you prefer.
      </p>
    </div>
  )
}

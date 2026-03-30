import { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck,
  Terminal,
  KeyRound,
  CreditCard,
  Code2,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Settings
} from 'lucide-react'
import type { SubscriptionCheckResult } from '../../../../shared/types'

type CheckStatus = 'idle' | 'checking' | 'success' | 'warning' | 'error'

interface CheckRowProps {
  icon: React.ReactNode
  label: string
  detail: string | null
  status: CheckStatus
  statusLabel: string
  error: string | null
}

function CheckRow({ icon, label, detail, status, statusLabel, error }: CheckRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const statusIcon = {
    idle: <div className="w-3 h-3 rounded-full bg-surface-float" />,
    checking: <Loader2 size={14} className="animate-spin text-primary-text" />,
    success: <CheckCircle2 size={14} className="text-green-400" />,
    warning: <AlertTriangle size={14} className="text-amber-400" />,
    error: <XCircle size={14} className="text-red-400" />
  }

  const statusColor = {
    idle: 'text-text-muted',
    checking: 'text-primary-text',
    success: 'text-green-400',
    warning: 'text-amber-400',
    error: 'text-red-400'
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => error && setExpanded(!expanded)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-base border border-border-subtle transition-colors ${error ? 'cursor-pointer hover:bg-surface-overlay' : 'cursor-default'}`}
      >
        <span className="text-text-secondary flex-shrink-0">{icon}</span>
        <span className="text-sm font-medium text-text-primary flex-1 text-left">{label}</span>
        <span className="text-xs text-text-secondary font-mono truncate max-w-[140px]">
          {status === 'checking' ? '...' : detail ?? '\u2014'}
        </span>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${statusColor[status]}`}>
          {statusIcon[status]}
          {statusLabel}
        </span>
      </button>
      {expanded && error && (
        <div className="mx-3 mt-1 mb-1 px-3 py-2 bg-surface-base border border-border-subtle rounded text-xs text-text-secondary break-words">
          {error}
        </div>
      )}
    </div>
  )
}

export default function AISubscriptionsSection(): React.JSX.Element {
  const [result, setResult] = useState<SubscriptionCheckResult | null>(null)
  const [isValidating, setIsValidating] = useState(false)
  const [isConfiguring, setIsConfiguring] = useState(false)
  const [configureError, setConfigureError] = useState<string | null>(null)

  const runValidation = useCallback(async () => {
    setIsValidating(true)
    setConfigureError(null)
    try {
      const data = await window.api.validateSubscriptions()
      setResult(data)
    } catch (err) {
      console.error('Subscription validation failed:', err)
    } finally {
      setIsValidating(false)
    }
  }, [])

  // Auto-validate on mount
  useEffect(() => {
    runValidation()
  }, [runValidation])

  const handleAutoConfigure = useCallback(async () => {
    setIsConfiguring(true)
    setConfigureError(null)
    try {
      const res = await window.api.autoConfigureClaude()
      if (res.success) {
        // Re-validate after successful install
        await runValidation()
      } else {
        setConfigureError(res.error ?? 'Installation failed')
      }
    } catch (err) {
      setConfigureError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsConfiguring(false)
    }
  }, [runValidation])

  // Derive row statuses
  const cliStatus: CheckStatus = isValidating
    ? 'checking'
    : result
      ? result.claudeCli.installed
        ? 'success'
        : 'error'
      : 'idle'

  const authStatus: CheckStatus = isValidating
    ? 'checking'
    : result
      ? result.claudeAuth.authenticated
        ? 'success'
        : result.claudeCli.installed
          ? 'error'
          : 'warning'
      : 'idle'

  const maxStatus: CheckStatus = isValidating
    ? 'checking'
    : result
      ? result.claudeMax.active
        ? 'success'
        : result.claudeAuth.authenticated
          ? 'warning'
          : 'warning'
      : 'idle'

  const codexStatus: CheckStatus = isValidating
    ? 'checking'
    : result
      ? result.codexCli.installed
        ? 'success'
        : 'warning'
      : 'idle'

  const showAutoConfigureButton = result && !result.claudeCli.installed

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-0.5">
        <ShieldCheck size={15} className="text-primary-text" />
        <h4 className="text-sm font-medium text-text-primary">AI Subscriptions</h4>
      </div>
      <p className="text-xs text-text-secondary mb-4">
        Validate and configure your AI service credentials
      </p>

      {/* Check rows */}
      <div className="space-y-1.5">
        <CheckRow
          icon={<Terminal size={14} />}
          label="Claude CLI"
          detail={result?.claudeCli.version ?? null}
          status={cliStatus}
          statusLabel={
            isValidating
              ? 'Checking...'
              : result
                ? result.claudeCli.installed
                  ? 'Installed'
                  : 'Not Found'
                : 'Pending'
          }
          error={result?.claudeCli.error ?? null}
        />
        <CheckRow
          icon={<KeyRound size={14} />}
          label="Claude Auth"
          detail={result?.claudeAuth.accountEmail ?? null}
          status={authStatus}
          statusLabel={
            isValidating
              ? 'Checking...'
              : result
                ? result.claudeAuth.authenticated
                  ? 'Logged In'
                  : 'Not Authenticated'
                : 'Pending'
          }
          error={result?.claudeAuth.error ?? null}
        />
        <CheckRow
          icon={<CreditCard size={14} />}
          label="Claude Max"
          detail={result?.claudeMax.plan ?? null}
          status={maxStatus}
          statusLabel={
            isValidating
              ? 'Checking...'
              : result
                ? result.claudeMax.active
                  ? 'Active'
                  : 'Inactive'
                : 'Pending'
          }
          error={result?.claudeMax.error ?? null}
        />
        <CheckRow
          icon={<Code2 size={14} />}
          label="Codex CLI"
          detail={result?.codexCli.version ?? null}
          status={codexStatus}
          statusLabel={
            isValidating
              ? 'Checking...'
              : result
                ? result.codexCli.installed
                  ? 'Installed'
                  : 'Not Found'
                : 'Pending'
          }
          error={result?.codexCli.error ?? null}
        />
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={runValidation}
          disabled={isValidating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} />
          {isValidating ? 'Validating...' : 'Validate All'}
        </button>
        {showAutoConfigureButton && (
          <button
            onClick={handleAutoConfigure}
            disabled={isConfiguring}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-float hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Settings size={12} className={isConfiguring ? 'animate-spin' : ''} />
            {isConfiguring ? 'Installing...' : 'Auto-Configure Claude'}
          </button>
        )}
      </div>

      {/* Configure error */}
      {configureError && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <strong>Auto-configure failed:</strong> {configureError}
        </div>
      )}
    </div>
  )
}

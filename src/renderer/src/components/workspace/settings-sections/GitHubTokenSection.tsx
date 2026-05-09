import React from 'react'
import { Check, X, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'

interface GitHubTokenSectionProps {
  configured: boolean
  login?: string
  tokenType?: string
  token: string
  isSavingToken: boolean
  tokenError: string | null
  tokenSuccess: string | null
  onTokenChange: (token: string) => void
  onSaveToken: () => void
  onDisconnect: () => void
}

export default function GitHubTokenSection({
  configured,
  login,
  tokenType,
  token,
  isSavingToken,
  tokenError,
  tokenSuccess,
  onTokenChange,
  onSaveToken,
  onDisconnect
}: GitHubTokenSectionProps): React.JSX.Element {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          GitHub Connection
        </h3>
        {configured && (
          <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
            <Check size={10} />
            Connected
          </span>
        )}
      </div>

      <SettingsCard>
        {configured ? (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-success-muted flex items-center justify-center shrink-0">
              <Check size={16} className="text-success" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">{login}</span>
              <p className="text-xs text-text-secondary">
                {tokenType === 'fine-grained'
                  ? 'Fine-Grained Personal Access Token'
                  : 'Personal Access Token · repo scope'}
              </p>
            </div>
            <button
              onClick={onDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded-lg transition-colors shrink-0"
            >
              <X size={12} />
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-text-secondary">
              Connect a GitHub Personal Access Token to enable automatic PR creation. Both classic
              and fine-grained tokens are supported.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder="ghp_ or github_pat_…"
                className="flex-1 px-3 py-1.5 bg-surface-base border border-border-default rounded-lg text-xs text-text-body font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              <button
                onClick={onSaveToken}
                disabled={isSavingToken || !token.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {isSavingToken ? <Loader2 size={12} className="animate-spin" /> : 'Connect'}
              </button>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <a
                href="https://github.com/settings/tokens/new?scopes=repo"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary-text hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.open('https://github.com/settings/tokens/new?scopes=repo', '_blank')
                }}
              >
                Classic token (repo scope)
                <ExternalLink size={10} />
              </a>
              <span className="text-xs text-text-muted">or</span>
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary-text hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.open('https://github.com/settings/personal-access-tokens/new', '_blank')
                }}
              >
                Fine-grained token (Contents + PRs + Issues)
                <ExternalLink size={10} />
              </a>
            </div>
            {tokenError && (
              <p className="text-xs text-danger flex items-center gap-1">
                <AlertTriangle size={10} />
                {tokenError}
              </p>
            )}
            {tokenSuccess && (
              <p className="text-xs text-success flex items-center gap-1">
                <Check size={10} />
                {tokenSuccess}
              </p>
            )}
          </div>
        )}
      </SettingsCard>
    </section>
  )
}

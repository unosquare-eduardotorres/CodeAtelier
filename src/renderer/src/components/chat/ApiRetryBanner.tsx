import { RefreshCw } from 'lucide-react'

interface ApiRetryBannerProps {
  attempt: number
  maxRetries: number
  errorStatus: number | null
}

export default function ApiRetryBanner({
  attempt,
  maxRetries,
  errorStatus
}: ApiRetryBannerProps): React.JSX.Element {
  const statusLabel =
    errorStatus === 529
      ? 'Claude API is overloaded'
      : errorStatus === 503
        ? 'Claude API is temporarily unavailable'
        : 'Transient API error'

  return (
    <div
      data-testid="api-retry-banner"
      className="mx-4 mt-2 flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-300 px-4 py-3 animate-in fade-in slide-in-from-top-2 duration-300"
    >
      <RefreshCw size={16} className="animate-spin" />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{statusLabel}</span>
        <span className="text-xs opacity-70">
          Retrying ({attempt}/{maxRetries})… If this persists, check{' '}
          <a
            href="https://status.claude.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-amber-200"
          >
            status.claude.com
          </a>
        </span>
      </div>
    </div>
  )
}

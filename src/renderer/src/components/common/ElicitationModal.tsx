import { useEffect, useState, useCallback } from 'react'
import { KeyRound, ExternalLink, X, Check } from 'lucide-react'

interface ElicitationRequest {
  requestId: string
  serverName: string
  message: string
  mode: 'form' | 'url'
  url?: string
  requestedSchema?: Record<string, unknown>
}

export default function ElicitationModal(): React.JSX.Element | null {
  const [request, setRequest] = useState<ElicitationRequest | null>(null)

  useEffect(() => {
    const cleanup = window.api.onSdkElicitationRequest(
      (data) => setRequest(data as ElicitationRequest)
    )
    return cleanup
  }, [])

  const handleAccept = useCallback(
    (content?: Record<string, unknown>) => {
      if (!request) return
      window.api.sdkElicitationRespond({
        requestId: request.requestId,
        action: 'accept',
        content
      })
      setRequest(null)
    },
    [request]
  )

  const handleDecline = useCallback(() => {
    if (!request) return
    window.api.sdkElicitationRespond({
      requestId: request.requestId,
      action: 'decline'
    })
    setRequest(null)
  }, [request])

  if (!request) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50">
      <div className="bg-surface-float rounded-xl shadow-2xl w-[420px] border border-border-default">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-default">
          <KeyRound size={18} className="text-amber-400 flex-shrink-0" />
          <h3 className="text-base font-semibold text-text-primary">
            {request.serverName} needs authentication
          </h3>
          <button
            onClick={handleDecline}
            className="ml-auto p-1 rounded-lg hover:bg-surface-overlay transition-colors"
            aria-label="Close"
          >
            <X size={16} className="text-text-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm text-text-body">{request.message}</p>

          {request.mode === 'url' && request.url && (
            <button
              onClick={() => window.open(request.url, '_blank')}
              className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <ExternalLink size={16} />
              Open Browser to Authenticate
            </button>
          )}

          {/* Form mode — future enhancement: render fields from requestedSchema */}
          {request.mode === 'form' && request.requestedSchema && (
            <div className="mt-3 p-3 bg-surface-overlay rounded-lg">
              <p className="text-xs text-text-muted">
                Form-based authentication — please complete the authentication flow in your browser.
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-default">
          <button
            onClick={handleDecline}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
          >
            <X size={14} />
            Cancel
          </button>
          <button
            onClick={() => handleAccept()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg transition-colors"
          >
            <Check size={14} />
            Done — I&apos;ve authenticated
          </button>
        </div>
      </div>
    </div>
  )
}

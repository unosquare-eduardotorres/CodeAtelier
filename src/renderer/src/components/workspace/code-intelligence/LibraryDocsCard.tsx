import { useState, useEffect } from 'react'
import { BookOpen, Eye, EyeOff, Check } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'

interface LibraryDocsCardProps {
  workspaceId: string
}

export default function LibraryDocsCard({ workspaceId }: LibraryDocsCardProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)

  // Load current key on mount
  useEffect(() => {
    window.api.getAppPreferences().then((prefs) => {
      if (prefs.context7ApiKey) setApiKey(prefs.context7ApiKey)
    })
  }, [])

  const handleSave = async (): Promise<void> => {
    await window.api.setAppPreference({ key: 'context7_api_key', value: apiKey })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-2 mb-3">
        <BookOpen size={14} className="text-text-secondary" />
        <h3 className="text-sm font-medium text-text-body">Library Documentation</h3>
      </div>

      <p className="text-xs text-text-secondary mb-3">
        Provides current, version-specific documentation for your dependencies. Docs are cached
        locally from node_modules. A Context7 API key enables lookup for libraries not installed in
        the workspace.
      </p>

      {/* Context7 API Key input */}
      <div className="space-y-2">
        <label className="text-xs text-text-secondary">
          Context7 API Key{' '}
          <span className="text-text-muted">(optional — for fallback lookups)</span>
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setSaved(false)
              }}
              placeholder="ctx7sk-..."
              className="w-full px-2 py-1.5 text-xs font-mono rounded
                bg-surface-base border border-border-subtle text-text-body
                placeholder:text-text-muted focus:outline-none focus:border-accent-primary"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
            >
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs rounded bg-accent-primary text-white
              hover:bg-accent-primary/90 flex items-center gap-1"
          >
            {saved ? (
              <>
                <Check size={12} /> Saved
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
        <p className="text-[10px] text-text-muted">
          Get a free key at{' '}
          <a
            href="https://context7.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="text-accent-primary hover:underline"
          >
            context7.com/dashboard
          </a>
          . Without a key, only local node_modules docs and npm registry are used.
        </p>
      </div>
    </SettingsCard>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, HardDrive, Info } from 'lucide-react'
import { GithubIcon } from '../common/icons/GithubIcon'
import { useUpdateStore } from '@renderer/store'
import type { UpdateSourceProvider } from '../../../../shared/types'
import UpdateButton from './UpdateButton'

export default function UpdateSettingsSection(): React.JSX.Element {
  const { status, availableVersion, config, configLoaded, loadConfig } = useUpdateStore()
  const [appVersion, setAppVersion] = useState<string>('')
  const [localDrivePath, setLocalDrivePath] = useState(config.drivePath)
  const [localGithubOwner, setLocalGithubOwner] = useState(config.githubOwner)
  const [localGithubRepo, setLocalGithubRepo] = useState(config.githubRepo)

  useEffect(() => {
    if (!configLoaded) {
      loadConfig()
    }
  }, [configLoaded, loadConfig])

  // Sync local state when config loads
  useEffect(() => {
    setLocalDrivePath(config.drivePath)
    setLocalGithubOwner(config.githubOwner)
    setLocalGithubRepo(config.githubRepo)
  }, [config])

  // Load app version
  useEffect(() => {
    window.api.getPlatformInfo().then((info) => {
      setAppVersion(info.appVersion)
    })
  }, [])

  const handleSourceChange = useCallback((source: UpdateSourceProvider) => {
    useUpdateStore.getState().setSource(source)
  }, [])

  const handleBrowseDrivePath = useCallback(async () => {
    const selected = await window.api.selectDirectory()
    if (selected) {
      setLocalDrivePath(selected)
      useUpdateStore.getState().setDrivePath(selected)
    }
  }, [])

  const handleDrivePathBlur = useCallback(() => {
    if (localDrivePath !== config.drivePath) {
      useUpdateStore.getState().setDrivePath(localDrivePath)
    }
  }, [localDrivePath, config.drivePath])

  const handleGithubBlur = useCallback(() => {
    if (localGithubOwner !== config.githubOwner || localGithubRepo !== config.githubRepo) {
      useUpdateStore.getState().setGithubConfig(localGithubOwner, localGithubRepo)
    }
  }, [localGithubOwner, localGithubRepo, config.githubOwner, config.githubRepo])

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded-lg p-5 shadow-sm space-y-5">
      {/* Header with version + check button */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-text-primary">Updates</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            Current Version:{' '}
            <span className="font-mono font-medium text-text-primary">
              {appVersion ? `v${appVersion}` : '—'}
            </span>
            {status === 'available' && availableVersion && (
              <span className="ml-2 text-info">
                → <span className="font-medium">v{availableVersion}</span> available
              </span>
            )}
          </p>
        </div>
        <UpdateButton />
      </div>

      {/* Source selector */}
      <div className="space-y-3">
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
          Update Source
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => handleSourceChange('drive')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
              config.source === 'drive'
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle text-text-secondary hover:bg-surface-base'
            }`}
          >
            <HardDrive size={14} />
            Cloud Drive
          </button>
          <button
            onClick={() => handleSourceChange('github')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
              config.source === 'github'
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle text-text-secondary hover:bg-surface-base'
            }`}
          >
            <GithubIcon size={14} />
            GitHub
          </button>
        </div>
      </div>

      {/* Drive config */}
      {config.source === 'drive' && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-text-primary">Drive Path</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={localDrivePath}
              onChange={(e) => setLocalDrivePath(e.target.value)}
              onBlur={handleDrivePathBlur}
              placeholder="/path/to/cloud-drive/releases"
              className="flex-1 px-3 py-1.5 text-xs bg-surface-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
            />
            <button
              onClick={handleBrowseDrivePath}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border-subtle text-text-secondary hover:bg-surface-base transition-colors"
            >
              <FolderOpen size={12} />
              Browse
            </button>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-text-muted">
            <Info size={11} className="mt-0.5 shrink-0" />
            Folder must contain{' '}
            <code className="px-1 py-0.5 bg-surface-base rounded text-[10px]">
              latest-mac.yml
            </code>{' '}
            + <code className="px-1 py-0.5 bg-surface-base rounded text-[10px]">.zip</code> for
            macOS auto-update.
          </p>
        </div>
      )}

      {/* GitHub config */}
      {config.source === 'github' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-primary">Owner</label>
              <input
                type="text"
                value={localGithubOwner}
                onChange={(e) => setLocalGithubOwner(e.target.value)}
                onBlur={handleGithubBlur}
                placeholder="owner"
                className="w-full px-3 py-1.5 text-xs bg-surface-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-primary">Repository</label>
              <input
                type="text"
                value={localGithubRepo}
                onChange={(e) => setLocalGithubRepo(e.target.value)}
                onBlur={handleGithubBlur}
                placeholder="repo"
                className="w-full px-3 py-1.5 text-xs bg-surface-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
              />
            </div>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
            <Info size={11} className="mt-0.5 shrink-0" />
            GitHub artifact source will be fully available in a future release.
          </p>
        </div>
      )}
    </div>
  )
}

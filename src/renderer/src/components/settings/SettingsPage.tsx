import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Settings,
  RefreshCw,
  Download,
  CheckCircle2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Loader2,
  FolderOpen,
  HardDrive,
  Github,
  Info
} from 'lucide-react'
import {
  useUpdateStore,
  useSpecialistStore,
  useAppPreferenceActions,
  useSpecialistWarningPreferences,
  useAppPreferenceStatus,
  useWorkspaceStore,
  useChatBubbleSize
} from '@renderer/store'
import { Avatar } from '@renderer/components/common'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import type { Specialist, ChatBubbleSize, UpdateSourceProvider } from '../../../../shared/types'
import AISubscriptionsSection from './AISubscriptionsSection'

function UpdateButton(): React.JSX.Element {
  const { status, availableVersion, checkForUpdates, installUpdate } = useUpdateStore()

  if (status === 'ready') {
    return (
      <button
        onClick={installUpdate}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-success border border-success/30 hover:bg-success-muted transition-colors"
      >
        <CheckCircle2 size={12} />
        Install Update (v{availableVersion})
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button
        onClick={() => useUpdateStore.getState().downloadUpdate()}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary-text border border-primary/30 hover:bg-primary-muted transition-colors"
      >
        <Download size={12} />
        Download v{availableVersion}
      </button>
    )
  }

  return (
    <button
      onClick={checkForUpdates}
      disabled={status === 'checking' || status === 'downloading'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-overlay hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshCw size={12} className={status === 'checking' ? 'animate-spin' : ''} />
      {status === 'checking'
        ? 'Checking...'
        : status === 'downloading'
          ? 'Downloading...'
          : 'Check for Updates'}
    </button>
  )
}

interface SettingsPageProps {
  onBack: () => void
}

function SpecialistWarningPreferencesSection(): React.JSX.Element {
  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()
  const { loadPreferences, setPreference } = useAppPreferenceActions()
  const { isLoading, savingKeys, error } = useAppPreferenceStatus()

  useEffect(() => {
    void loadPreferences().catch((loadError) => {
      console.error('Failed to load specialist warning preferences:', loadError)
    })
  }, [loadPreferences])

  const rows: Array<{
    key: 'specialistWarningBuild' | 'specialistWarningPlan' | 'specialistWarningAlways'
    label: string
    description: string
    checked: boolean
  }> = [
    {
      key: 'specialistWarningBuild',
      label: 'Build mode warnings',
      description: 'Warn before build actions when specialist activation can increase token usage.',
      checked: specialistWarningBuild
    },
    {
      key: 'specialistWarningPlan',
      label: 'Plan mode warnings',
      description: 'Warn before plan actions when specialist activation can increase token usage.',
      checked: specialistWarningPlan
    },
    {
      key: 'specialistWarningAlways',
      label: 'Always show warning dialog',
      description:
        'Always show specialist warning dialog regardless of mode-specific warning toggles.',
      checked: specialistWarningAlways
    }
  ]

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-text-primary">Specialist Activation Warnings</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            Control when confirmation dialogs appear before specialist-enhanced actions.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <div className="text-xs text-text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Loading preferences...
          </div>
        ) : (
          rows.map((row) => {
            const isSavingRow = savingKeys[row.key] ?? false
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface-base px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-text-body">{row.label}</p>
                  <p className="text-xs text-text-secondary">{row.description}</p>
                </div>

                <button
                  onClick={() => {
                    void setPreference(row.key, !row.checked).catch((setError) => {
                      console.error(`Failed to update preference "${row.key}":`, setError)
                    })
                  }}
                  disabled={isSavingRow}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    row.checked ? 'bg-primary' : 'bg-surface-base border border-border-default'
                  }`}
                  role="switch"
                  aria-checked={row.checked}
                  aria-label={row.label}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                      row.checked ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )
          })
        )}
      </div>

      {error && (
        <p className="text-xs text-danger mt-3">Failed to update warning preferences: {error}</p>
      )}
    </div>
  )
}

const BUBBLE_SIZE_OPTIONS: { value: ChatBubbleSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: 'Compact text, tighter bubbles' },
  { value: 'medium', label: 'Medium', description: 'Balanced readability' },
  { value: 'large', label: 'Large', description: 'Comfortable reading' },
  { value: 'xl', label: 'XL', description: 'Maximum readability' }
]

function ChatBubbleSizeSection(): React.JSX.Element {
  const currentSize = useChatBubbleSize()
  const { setPreference } = useAppPreferenceActions()

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Chat Bubble Size</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-3">
        Control the text size and width of chat message bubbles.
      </p>
      <div className="grid grid-cols-4 gap-2">
        {BUBBLE_SIZE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => {
              void setPreference('chatBubbleSize', opt.value).catch(console.error)
            }}
            className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
              currentSize === opt.value
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            <span>{opt.label}</span>
            <span className="text-[10px] text-text-muted font-normal">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SpecialistOrder(): React.JSX.Element {
  const { specialists, reorderSpecialists } = useSpecialistStore()
  const activeWs = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const mannequinKey = activeWs ? getWorkspaceMannequin(activeWs.id, workspaces) : 'mannequin-main'
  const [orderedList, setOrderedList] = useState<Specialist[]>([])
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Initialize from active specialists sorted by priority (exclude user — always priority -1)
  useEffect(() => {
    const active = [...specialists]
      .filter((s) => s.isActive && s.agentId !== 'user')
      .sort((a, b) => a.priority - b.priority)
    setOrderedList(active)
  }, [specialists])

  const handleDragStart = (index: number): void => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return
    const updated = [...orderedList]
    const [moved] = updated.splice(draggedIndex, 1)
    updated.splice(index, 0, moved)
    setOrderedList(updated)
    setDraggedIndex(index)
  }

  const handleDragEnd = async (): Promise<void> => {
    setDraggedIndex(null)
    setIsSaving(true)
    try {
      await reorderSpecialists(orderedList.map((s) => s.id))
    } finally {
      setIsSaving(false)
    }
  }

  const moveItem = useCallback(
    async (from: number, to: number) => {
      const updated = [...orderedList]
      const [moved] = updated.splice(from, 1)
      updated.splice(to, 0, moved)
      setOrderedList(updated)
      setIsSaving(true)
      try {
        await reorderSpecialists(updated.map((s) => s.id))
      } finally {
        setIsSaving(false)
      }
    },
    [orderedList, reorderSpecialists]
  )

  if (orderedList.length === 0) return <></>

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Specialist Priority Order</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-4">
        Drag to reorder. Specialists listed first are presented first to the generalist when
        decomposing tasks into sub-tasks.
      </p>
      <div className="space-y-1">
        {orderedList.map((specialist, index) => (
          <div
            key={specialist.id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing
              ${
                draggedIndex === index
                  ? 'border-primary/50 bg-primary/5 scale-[1.02] shadow-md'
                  : 'border-border-subtle bg-surface-base hover:bg-surface-overlay'
              }
            `}
          >
            <GripVertical size={14} className="text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted w-5 font-mono">{index + 1}</span>
            <Avatar
              avatarKey={specialist.agentId === 'user' ? 'user' : mannequinKey}
              size="sm"
              accentColor={specialist.color}
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                {specialist.displayName}
              </span>
              {specialist.alias && (
                <span className="text-xs text-text-muted ml-1.5">({specialist.alias})</span>
              )}
            </div>
            {/* Up/Down buttons for accessibility */}
            <div className="flex flex-col gap-0.5">
              <button
                disabled={index === 0}
                onClick={() => moveItem(index, index - 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronUp size={12} />
              </button>
              <button
                disabled={index === orderedList.length - 1}
                onClick={() => moveItem(index, index + 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {isSaving && (
        <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" /> Saving order...
        </p>
      )}
    </div>
  )
}

function UpdateSettingsSection(): React.JSX.Element {
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

  const handleSourceChange = useCallback(
    (source: UpdateSourceProvider) => {
      useUpdateStore.getState().setSource(source)
    },
    []
  )

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
            <Github size={14} />
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
            Folder must contain <code className="px-1 py-0.5 bg-surface-base rounded text-[10px]">latest-mac.yml</code> +{' '}
            <code className="px-1 py-0.5 bg-surface-base rounded text-[10px]">.zip</code> for macOS auto-update.
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

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <Settings size={16} className="text-primary-text" />
        <span className="text-sm font-semibold text-text-primary">App Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Application</h3>
              <p className="text-xs text-text-secondary">
                App-level settings and updates. Agents and skills are managed per workspace in
                Workspace Settings.
              </p>
            </div>

            {/* AI Subscriptions section */}
            <AISubscriptionsSection />

            {/* Chat bubble size */}
            <ChatBubbleSizeSection />

            {/* Specialist warning preferences */}
            <SpecialistWarningPreferencesSection />

            {/* Specialist Priority Order */}
            <SpecialistOrder />

            {/* Update section — expanded */}
            <UpdateSettingsSection />
          </div>
        </div>
      </div>
    </div>
  )
}

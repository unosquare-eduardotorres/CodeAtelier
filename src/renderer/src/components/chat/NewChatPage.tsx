import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ClipboardList,
  Hammer,
  Lightbulb,
  GitBranch,
  Puzzle,
  Smartphone,
  Network,
  Search,
  Clock,
  BarChart3,
  MessageSquare,
  Heart,
  Sun,
  Flame,
  Bone
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { GithubIcon } from '../common/icons/GithubIcon'
import { useProfileStore, useWorkspaceStore, useAuditStore } from '@renderer/store'
import { useClipboardImagePaste, IMAGE_REGEX } from '@renderer/hooks'
import { AttachmentDropzone } from '@renderer/components/chat'
import type { CommunicationTone, ConversationMode, LLMProvider, ModelRoleMap } from '../../../../shared/types'
import {
  COMMUNICATION_TONES,
  EXTERNAL_MCP_INTEGRATIONS,
  LOCAL_MCP_INTEGRATIONS
} from '../../../../shared/constants'
import type { ExternalMcpDefinition, LocalMcpDefinition } from '../../../../shared/constants'
import ToggleButtonGroup from './ToggleButtonGroup'
import McpToolsSection from './McpToolsSection'
import { ModelPicker } from './ModelPicker'
import { useWorkspaceModelInfo } from './useWorkspaceModelInfo'

/** Map tone icon names to Lucide components */
const TONE_ICON_MAP: Record<string, LucideIcon> = { MessageSquare, Heart, Sun, Flame, Bone }

interface NewChatPageProps {
  onCreateChat: (data: {
    title: string
    description?: string
    mode: ConversationMode
    communicationTone?: CommunicationTone | null
    attachments?: string[]
    useIsolatedBranch?: boolean
    llmProvider?: LLMProvider
    routingOverrides?: Partial<ModelRoleMap>
    mcpOverrides?: Record<string, boolean>
    sourceAuditRunId?: string
  }) => void
  onCreateIdea?: (data: { title: string; description?: string }) => void
}

type McpSubTab = 'external' | 'system'

const TITLE_MAX = 500
const DESCRIPTION_MAX = 15_000

// ── buildMcpPayload — lean MCP override payload ──────────────────────────

function buildMcpPayload(
  availableLocalMcps: LocalMcpDefinition[],
  availableIntegrations: ExternalMcpDefinition[],
  mcpOverrides: Record<string, boolean>
): Record<string, boolean> | undefined {
  const payload: Record<string, boolean> = {}
  for (const lm of availableLocalMcps) {
    if (mcpOverrides[lm.id] === false) payload[lm.id] = false
  }
  for (const ext of availableIntegrations) {
    if (mcpOverrides[ext.id]) payload[ext.id] = true
  }
  return Object.keys(payload).length > 0 ? payload : undefined
}

// ── useWorkspaceSettings — loads provider + MCP config ───────────────────

function useMcpSettings(activeWorkspace: { id: string } | null) {
  const [mcpOverrides, setMcpOverrides] = useState<Record<string, boolean>>({})
  const [showMcpTools, setShowMcpTools] = useState(false)
  const [availableIntegrations, setAvailableIntegrations] = useState<ExternalMcpDefinition[]>([])
  const [availableLocalMcps, setAvailableLocalMcps] = useState<LocalMcpDefinition[]>([])

  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((s) => {
        const available = EXTERNAL_MCP_INTEGRATIONS.filter((i) => !!s[`${i.id}Available`])
        setAvailableIntegrations(available)
        setShowMcpTools(available.length > 0)
        const availableLocal = LOCAL_MCP_INTEGRATIONS.filter((lm) => {
          if (!lm.featureFlagKey) return true
          return !!s[lm.featureFlagKey]
        })
        setAvailableLocalMcps(availableLocal)
        const localDefaults: Record<string, boolean> = {}
        for (const lm of availableLocal) {
          localDefaults[lm.id] = lm.defaultEnabled
        }
        setMcpOverrides((prev) => ({ ...localDefaults, ...prev }))
      })
      .catch((err) =>
        console.warn('[NewChatPage] Non-fatal: workspace settings load failed:', err)
      )
  }, [activeWorkspace])

  return {
    availableIntegrations,
    availableLocalMcps,
    showMcpTools,
    setShowMcpTools,
    mcpOverrides,
    setMcpOverrides
  }
}

// ── ToneSelector ─────────────────────────────────────────────────────────

function ToneSelector({
  value,
  onChange
}: {
  value: CommunicationTone | null
  onChange: (tone: CommunicationTone | null) => void
}): React.JSX.Element {
  return (
    <div data-testid="new-chat-tone-selector" className="w-full mb-5">
      <label className="block text-sm font-medium text-text-primary mb-1.5">
        Tone{' '}
        <span className="text-text-muted font-normal">(uses workspace default if unset)</span>
      </label>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => onChange(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
            value === null
              ? 'bg-primary-muted text-primary-text border border-primary/20'
              : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
          }`}
        >
          Workspace Default
        </button>
        {COMMUNICATION_TONES.filter((t) => t.id !== 'default').map((tone) => {
          const Icon = TONE_ICON_MAP[tone.icon] ?? MessageSquare
          const isActive = value === tone.id
          return (
            <button
              key={tone.id}
              onClick={() => onChange(tone.id as CommunicationTone)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                isActive
                  ? 'bg-primary-muted text-primary-text border border-primary/20'
                  : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
              }`}
            >
              <Icon size={12} />
              {tone.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── NewChatPage ──────────────────────────────────────────────────────────

export default function NewChatPage({
  onCreateChat,
  onCreateIdea
}: NewChatPageProps): React.JSX.Element {
  const userName = useProfileStore((s) => s.profile?.displayName?.split(' ')[0] ?? null)
  const { activeWorkspace } = useWorkspaceStore()
  const pendingFixContext = useAuditStore((s) => s.pendingFixContext)
  const setPendingFixContext = useAuditStore((s) => s.setPendingFixContext)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<ConversationMode>('plan')
  const [communicationTone, setConversationTone] = useState<CommunicationTone | null>(null)
  const [attachments, setAttachments] = useState<string[]>([])
  const [useIsolatedBranch, setUseIsolatedBranch] = useState(false)
  const {
    modelRoles: workspaceModelRoles,
    claudeModelOverrides,
    derivedProvider,
    omlxModels
  } = useWorkspaceModelInfo(activeWorkspace?.id)
  const {
    availableIntegrations,
    availableLocalMcps,
    showMcpTools,
    setShowMcpTools,
    mcpOverrides,
    setMcpOverrides
  } = useMcpSettings(activeWorkspace)
  const [routingOverrides, setRoutingOverrides] = useState<Partial<ModelRoleMap>>({})
  const [mcpSubTab, setMcpSubTab] = useState<McpSubTab>('external')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Clipboard image paste from the Description field. The textarea is a sibling
  // of AttachmentDropzone, so its paste events never reach the dropzone handler.
  const handleImageSaved = useCallback((filePath: string) => {
    setAttachments((prev) => [...prev, filePath])
  }, [])
  const handleDescriptionPaste = useClipboardImagePaste({
    conversationId: 'unsorted',
    imageCount: attachments.filter((p) => IMAGE_REGEX.test(p)).length,
    onImageSaved: handleImageSaved
  })

  // Auto-focus title input on mount
  useEffect(() => {
    const timer = setTimeout(() => titleInputRef.current?.focus(), 100)
    return (): void => clearTimeout(timer)
  }, [])

  // Pre-fill from audit fix context on mount (once)
  // When autoSend is set, skip the form and submit immediately.

  useEffect(() => {
    if (pendingFixContext) {
      const { title: ctxTitle, description: ctxDesc, autoSend, sourceAuditRunId } = pendingFixContext
      // Consume immediately to prevent re-application
      setPendingFixContext(null)

      if (autoSend && ctxTitle.trim()) {
        // Skip form — create conversation and send immediately
        onCreateChat({
          title: ctxTitle,
          description: ctxDesc || undefined,
          mode: 'plan',
          sourceAuditRunId
        })
      } else {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming pending fix context on mount
        setTitle(ctxTitle)
        setDescription(ctxDesc)
        setMode('plan') // Fixes default to plan mode
      }
    }
  }, [])

  // Computed values for MCP badge counts
  const activeLocalMcps = availableLocalMcps.filter((lm) => mcpOverrides[lm.id] !== false)
  const activeExternalMcps = availableIntegrations.filter((i) => !!mcpOverrides[i.id])

  const handleSubmit = useCallback(async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    // Model defaults are now configured exclusively in Settings → Models tab.
    // Chat creation should not silently rewrite workspace-wide settings.

    const mcpOverridesPayload = buildMcpPayload(availableLocalMcps, availableIntegrations, mcpOverrides)

    // Derive provider from routing overrides or workspace routing
    const effectiveProvider = routingOverrides['specialist:plan']?.provider ?? derivedProvider

    onCreateChat({
      title: trimmedTitle,
      description: description.trim() || undefined,
      mode,
      communicationTone,
      attachments: attachments.length > 0 ? attachments : undefined,
      useIsolatedBranch: mode === 'build' ? useIsolatedBranch : undefined,
      llmProvider: effectiveProvider,
      routingOverrides: Object.keys(routingOverrides).length > 0 ? routingOverrides : undefined,
      mcpOverrides: mcpOverridesPayload,
    })
  }, [
    title,
    description,
    mode,
    communicationTone,
    attachments,
    useIsolatedBranch,
    derivedProvider,
    routingOverrides,
    mcpOverrides,
    availableLocalMcps,
    availableIntegrations,
    onCreateChat
  ])

  const handleCreateIdea = useCallback((): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !onCreateIdea) return

    onCreateIdea({
      title: trimmedTitle,
      description: description.trim() || undefined
    })
  }, [title, description, onCreateIdea])

  // Submit on Cmd/Ctrl+Enter
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleSubmit])

  const isValid = title.trim().length > 0

  return (
    <div
      data-testid="new-chat-page"
      className="flex-1 flex flex-col bg-surface-raised min-w-0 min-h-0 overflow-y-auto"
    >
      <div className="flex-1 flex flex-col items-center justify-start px-8 py-10 max-w-3xl mx-auto w-full">
        {/* Greeting */}
        <h1 className="text-2xl font-bold text-text-primary mb-1 text-center">
          {userName ? `Hey ${userName}, ready to build?` : 'Ready to build?'}
        </h1>
        <p className="text-sm text-text-secondary mb-8 text-center">
          Configure your conversation and start building.
        </p>

        {/* Title */}
        <div className="w-full mb-5">
          <label
            htmlFor="new-chat-title"
            className="block text-sm font-medium text-text-primary mb-1.5"
          >
            Title <span className="text-danger">*</span>
          </label>
          <input
            ref={titleInputRef}
            id="new-chat-title"
            data-testid="new-chat-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
            placeholder="e.g., Add user authentication system"
            className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
            maxLength={TITLE_MAX}
            autoComplete="off"
          />
          <div className="flex justify-end mt-1">
            <span className="text-xs text-text-muted">
              {title.length}/{TITLE_MAX}
            </span>
          </div>
        </div>

        {/* Mode Toggle */}
        <ToggleButtonGroup
          data-testid="new-chat-mode-toggle"
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: 'plan',
              label: 'Plan',
              icon: ClipboardList,
              activeClass: 'bg-mode-plan-muted text-mode-plan-text border border-mode-plan-border'
            },
            {
              value: 'build',
              label: 'Build',
              icon: Hammer,
              activeClass:
                'bg-mode-build-muted text-mode-build-text border border-mode-build-border'
            }
          ]}
          description={
            mode === 'plan'
              ? 'Plan mode — read-only analysis, brainstorming, code review'
              : 'Build mode — the agent can create and modify files in your workspace'
          }
        />

        {/* Model Routing */}
        {activeWorkspace && (
          <ModelPicker
            workspaceModelRoles={workspaceModelRoles}
            claudeModelOverrides={claudeModelOverrides}
            workspaceProvider={derivedProvider}
            omlxModels={omlxModels}
            overrides={routingOverrides}
            onOverridesChange={setRoutingOverrides}
          />
        )}

        {/* Communication Tone */}
        <ToneSelector value={communicationTone} onChange={setConversationTone} />

        {/* Description */}
        <div className="w-full mb-5">
          <label
            htmlFor="new-chat-description"
            className="block text-sm font-medium text-text-primary mb-1.5"
          >
            Description <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <textarea
            id="new-chat-description"
            data-testid="new-chat-description"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
            onPaste={handleDescriptionPaste}
            placeholder="Describe what needs to be done, acceptance criteria, technical requirements, etc."
            rows={4}
            className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-y min-h-[80px] max-h-[200px]"
            maxLength={DESCRIPTION_MAX}
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs text-text-muted">
              Supports @path file references · paste images to attach
            </span>
            <span className="text-xs text-text-muted">
              {description.length.toLocaleString()}/{DESCRIPTION_MAX.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Attachments */}
        <div className="w-full mb-5">
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Attachments <span className="text-text-muted font-normal">(optional)</span>
          </label>
          <AttachmentDropzone
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            conversationId="unsorted"
          >
            <span className="text-sm text-text-muted">
              Drop files here or click the clip icon to attach
            </span>
          </AttachmentDropzone>
        </div>

        {/* Isolated branch checkbox — only in Build mode */}
        {mode === 'build' && (
          <div className="w-full mb-6">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={useIsolatedBranch}
                onChange={(e) => setUseIsolatedBranch(e.target.checked)}
                className="w-4 h-4 rounded border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
              />
              <div className="flex items-center gap-2">
                <GitBranch
                  size={14}
                  className="text-text-secondary group-hover:text-text-primary transition-colors"
                />
                <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                  Use isolated branch
                </span>
              </div>
              <span className="text-xs text-text-muted ml-auto">
                Creates a git worktree for this conversation
              </span>
            </label>
          </div>
        )}

        {/* MCP Tools — system + external integrations */}
        {(availableLocalMcps.length > 0 || availableIntegrations.length > 0) && (
          <McpToolsSection
            showMcpTools={showMcpTools}
            setShowMcpTools={setShowMcpTools}
            mcpSubTab={mcpSubTab}
            setMcpSubTab={setMcpSubTab}
            availableIntegrations={availableIntegrations}
            availableLocalMcps={availableLocalMcps}
            mcpOverrides={mcpOverrides}
            setMcpOverrides={setMcpOverrides}
            activeLocalMcps={activeLocalMcps}
            activeExternalMcps={activeExternalMcps}
          />
        )}

        {/* Action buttons */}
        <div className="w-full flex items-center justify-between pt-4 border-t border-border-subtle">
          <span className="text-xs text-text-muted">
            {/mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+'}Enter to create
          </span>
          <div className="flex items-center gap-2">
            {onCreateIdea && (
              <button
                data-testid="new-chat-create-idea-btn"
                onClick={handleCreateIdea}
                disabled={!isValid}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 press-scale ${
                  isValid
                    ? 'bg-warning-muted hover:bg-warning/25 text-warning border border-warning/30'
                    : 'bg-warning/5 text-warning/30 border border-warning/10 cursor-not-allowed'
                }`}
              >
                <Lightbulb size={14} />
                Create Idea
              </button>
            )}
            <button
              data-testid="new-chat-start-btn"
              onClick={handleSubmit}
              disabled={!isValid}
              className={`px-5 py-2.5 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary press-scale ${
                isValid
                  ? 'bg-primary hover:bg-primary-hover text-white'
                  : 'bg-primary/30 text-white/40 cursor-not-allowed'
              }`}
            >
              Start Conversation
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── McpRow — reusable row component ──────────────────────────────────────

const ICON_MAP: Record<string, React.FC<{ size?: number; className?: string }>> = {
  Network,
  Search,
  GitBranch,
  Clock,
  Github: GithubIcon,
  BarChart3,
  Smartphone,
  Puzzle
}

export function McpRow({
  id: _id,
  displayName,
  icon,
  toolCount,
  tokenImpact,
  description,
  active,
  onToggle
}: {
  id: string
  displayName: string
  icon: string
  toolCount: number
  tokenImpact: 'low' | 'medium' | 'high'
  description?: string
  active: boolean
  onToggle: () => void
}): React.JSX.Element {
  const Icon = ICON_MAP[icon] ?? Puzzle
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={14} className="text-text-secondary flex-shrink-0" />
        <span className="text-sm text-text-primary truncate">{displayName}</span>
        {description && (
          <span className="text-[10px] text-text-muted truncate hidden sm:inline">
            {description}
          </span>
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${
            tokenImpact === 'high'
              ? 'bg-danger-muted text-danger'
              : tokenImpact === 'medium'
                ? 'bg-warning-muted text-warning'
                : 'bg-success-muted text-success'
          }`}
        >
          {tokenImpact} · {toolCount} tools
        </span>
      </div>
      <button
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ml-3 ${
          active ? 'bg-accent' : 'bg-surface-base border border-border-default'
        }`}
        aria-label={`${active ? 'Disable' : 'Enable'} ${displayName}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            active ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}

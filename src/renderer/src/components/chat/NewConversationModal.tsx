import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ClipboardList,
  Hammer,
  GitBranch,
  Lightbulb,
  X,
  MessageSquare,
  Heart,
  Sun,
  Flame,
  Bone
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CommunicationTone, ConversationMode } from '../../../../shared/types'
import { COMMUNICATION_TONES } from '../../../../shared/constants'
import { AttachmentDropzone } from '@renderer/components/chat'
import { PresetSelector } from './PresetSelector'
import { useWorkspaceStore } from '@renderer/store/workspace.store'

/** Map tone icon names to Lucide components */
const TONE_ICON_MAP: Record<string, LucideIcon> = { MessageSquare, Heart, Sun, Flame, Bone }

interface NewConversationModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (data: {
    title: string
    description?: string
    mode: ConversationMode
    communicationTone?: CommunicationTone | null
    attachments?: string[]
    useIsolatedBranch?: boolean
    presetId?: string | null
  }) => void
  onCreateIdea?: (data: { title: string; description?: string }) => void
}

const TITLE_MAX = 500
const DESCRIPTION_MAX = 15_000

export default function NewConversationModal({
  isOpen,
  onClose,
  onSubmit,
  onCreateIdea
}: NewConversationModalProps): React.JSX.Element | null {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<ConversationMode>('plan')
  const [conversationTone, setConversationTone] = useState<CommunicationTone | null>(null)
  const [attachments, setAttachments] = useState<string[]>([])
  const [useIsolatedBranch, setUseIsolatedBranch] = useState(false)
  const [presetId, setPresetId] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  // Auto-focus title input when opened
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure the modal is rendered before focusing
      const timer = setTimeout(() => titleInputRef.current?.focus(), 50)
      return (): void => clearTimeout(timer)
    }
    return undefined
  }, [isOpen])

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle('')
      setDescription('')
      setMode('plan')
      setConversationTone(null)
      setAttachments([])
      setUseIsolatedBranch(false)
      setPresetId(null)
    }
  }, [isOpen])

  // Escape key closes modal
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleSubmit = useCallback((): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    onSubmit({
      title: trimmedTitle,
      description: description.trim() || undefined,
      mode,
      communicationTone: conversationTone,
      attachments: attachments.length > 0 ? attachments : undefined,
      useIsolatedBranch: mode === 'build' ? useIsolatedBranch : undefined,
      presetId
    })
  }, [
    title,
    description,
    mode,
    conversationTone,
    attachments,
    useIsolatedBranch,
    presetId,
    onSubmit
  ])

  const handleCreateIdea = useCallback((): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !onCreateIdea) return

    onCreateIdea({
      title: trimmedTitle,
      description: description.trim() || undefined
    })
    onClose()
  }, [title, description, onCreateIdea, onClose])

  // Submit on Cmd/Ctrl+Enter
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleSubmit])

  if (!isOpen) return null

  const isValid = title.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-conversation-title"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div data-testid="new-conversation-modal" className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl max-w-2xl w-full mx-4 animate-in fade-in zoom-in-95 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle">
          <h2 id="new-conversation-title" className="text-lg font-semibold text-text-primary">
            Create New Chat
          </h2>
          <button
            onClick={onClose}
            className="p-2.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-left">
          {/* Title */}
          <div>
            <label
              htmlFor="conv-title"
              className="block text-sm font-medium text-text-primary mb-1.5"
            >
              Title <span className="text-danger">*</span>
            </label>
            <input
              ref={titleInputRef}
              id="conv-title"
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
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Mode</label>
            <div className="flex items-center gap-2 bg-surface-overlay rounded-lg p-1 border border-border-subtle w-fit">
              <button
                onClick={() => setMode('plan')}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  mode === 'plan'
                    ? 'bg-mode-plan-muted text-mode-plan-text border border-mode-plan-border'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <ClipboardList size={16} />
                Plan
              </button>
              <button
                onClick={() => {
                  setMode('build')
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  mode === 'build'
                    ? 'bg-mode-build-muted text-mode-build-text border border-mode-build-border'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Hammer size={16} />
                Build
              </button>
            </div>
            <p className="text-xs text-text-muted mt-1.5">
              {mode === 'plan'
                ? 'Plan mode — read-only analysis, brainstorming, code review'
                : 'Build mode — the agent can create and modify files in your workspace'}
            </p>
          </div>

          {/* LLM Preset Selector */}
          {activeWorkspace && (
            <PresetSelector
              workspaceId={activeWorkspace.id}
              presetId={presetId}
              onChange={setPresetId}
            />
          )}

          {/* Communication Tone */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Tone{' '}
              <span className="text-text-muted font-normal">(uses workspace default if unset)</span>
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setConversationTone(null)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  conversationTone === null
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
                }`}
              >
                Workspace Default
              </button>
              {COMMUNICATION_TONES.filter((t) => t.id !== 'default').map((tone) => {
                const Icon = TONE_ICON_MAP[tone.icon] ?? MessageSquare
                const isActive = conversationTone === tone.id
                return (
                  <button
                    key={tone.id}
                    onClick={() => setConversationTone(tone.id as CommunicationTone)}
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

          {/* Description */}
          <div>
            <label
              htmlFor="conv-description"
              className="block text-sm font-medium text-text-primary mb-1.5"
            >
              Description <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              id="conv-description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder="Describe what needs to be done, acceptance criteria, technical requirements, etc."
              rows={5}
              className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-y min-h-[80px] max-h-[240px]"
              maxLength={DESCRIPTION_MAX}
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-text-muted">Supports @path file references</span>
              <span className="text-xs text-text-muted">
                {description.length.toLocaleString()}/{DESCRIPTION_MAX.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Attachments */}
          <div>
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
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle">
          <span className="text-xs text-text-muted">
            {/mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+'}↵ to create
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
            >
              Cancel
            </button>
            {onCreateIdea && (
              <button
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
              data-testid="new-conversation-submit"
              onClick={handleSubmit}
              disabled={!isValid}
              className={`px-5 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary press-scale ${
                isValid
                  ? 'bg-primary hover:bg-primary-hover text-white'
                  : 'bg-primary/30 text-white/40 cursor-not-allowed'
              }`}
            >
              Create Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

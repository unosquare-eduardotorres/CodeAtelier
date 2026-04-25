import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ClipboardList, Hammer, Lightbulb, GitBranch } from 'lucide-react'
import { useSpecialistStore, useProfileStore } from '@renderer/store'
import { AttachmentDropzone } from '@renderer/components/chat'
import PersonaCard from './PersonaCard'
import type { ConversationMode } from '../../../../shared/types'

interface NewChatPageProps {
  onCreateChat: (data: {
    title: string
    description?: string
    mode: ConversationMode
    personaSpecialistId?: string
    attachments?: string[]
    useIsolatedBranch?: boolean
  }) => void
  onCreateIdea?: (data: { title: string; description?: string }) => void
}

const TITLE_MAX = 500
const DESCRIPTION_MAX = 15_000

export default function NewChatPage({
  onCreateChat,
  onCreateIdea
}: NewChatPageProps): React.JSX.Element {
  const userName = useProfileStore((s) => s.profile?.displayName?.split(' ')[0] ?? null)
  const specialists = useSpecialistStore((s) => s.specialists)

  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<ConversationMode>('plan')
  const [attachments, setAttachments] = useState<string[]>([])
  const [useIsolatedBranch, setUseIsolatedBranch] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus title input on mount
  useEffect(() => {
    const timer = setTimeout(() => titleInputRef.current?.focus(), 100)
    return (): void => clearTimeout(timer)
  }, [])

  // Categorize specialists for the persona grid
  const { daVinci, activeSpecialists, inactiveSpecialists } = useMemo(() => {
    const dv = specialists.find((s) => s.agentId === 'da-vinci')
    const active = specialists
      .filter((s) => !s.isCore && s.isActive && s.agentId !== 'orchestrator')
      .sort((a, b) => a.priority - b.priority)
    const inactive = specialists
      .filter((s) => !s.isCore && !s.isActive && s.agentId !== 'orchestrator')
      .sort((a, b) => a.priority - b.priority)
    return { daVinci: dv, activeSpecialists: active, inactiveSpecialists: inactive }
  }, [specialists])

  const handleSubmit = useCallback((): void => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    onCreateChat({
      title: trimmedTitle,
      description: description.trim() || undefined,
      mode,
      personaSpecialistId: selectedPersonaId,
      attachments: attachments.length > 0 ? attachments : undefined,
      useIsolatedBranch: mode === 'build' ? useIsolatedBranch : undefined
    })
  }, [title, description, mode, selectedPersonaId, attachments, useIsolatedBranch, onCreateChat])

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
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0 min-h-0 overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-start px-8 py-10 max-w-3xl mx-auto w-full">
        {/* Greeting */}
        <h1 className="text-2xl font-bold text-text-primary mb-1 text-center">
          {userName ? `Hey ${userName}, ready to build?` : 'Ready to build?'}
        </h1>
        <p className="text-sm text-text-secondary mb-8 text-center">
          Choose who you&apos;ll be talking to, then start your conversation.
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
        <div className="w-full mb-5">
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
              onClick={() => setMode('build')}
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
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
            placeholder="Describe what needs to be done, acceptance criteria, technical requirements, etc."
            rows={4}
            className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-y min-h-[80px] max-h-[200px]"
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

        {/* Persona Grid */}
        <div className="w-full mb-8">
          <label className="block text-sm font-medium text-text-primary mb-3">Talk to</label>
          <div className="flex flex-wrap gap-3">
            {/* Da Vinci (default) */}
            {daVinci && (
              <PersonaCard
                specialist={daVinci}
                isDefault
                selected={!selectedPersonaId}
                onSelect={() => setSelectedPersonaId(undefined)}
              />
            )}

            {/* Active specialists */}
            {activeSpecialists.map((s) => (
              <PersonaCard
                key={s.id}
                specialist={s}
                selected={selectedPersonaId === s.id}
                onSelect={() => setSelectedPersonaId(s.id)}
              />
            ))}

            {/* Inactive specialists (grayed out) */}
            {inactiveSpecialists.map((s) => (
              <PersonaCard
                key={s.id}
                specialist={s}
                selected={false}
                disabled
                onSelect={() => {
                  /* disabled */
                }}
              />
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="w-full flex items-center justify-between pt-4 border-t border-border-subtle">
          <span className="text-xs text-text-muted">
            {/mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+'}Enter to create
          </span>
          <div className="flex items-center gap-2">
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

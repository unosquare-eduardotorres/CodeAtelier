import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  Send,
  Square,
  Minimize2,
  Trash2,
  HelpCircle,
  GitPullRequestArrow,
  X,
  Flame,
  Lightbulb,
  Mic,
  MicOff
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  useChatStore,
  useChatActions,
  useWorkspaceStore,
  useConversationSpecialistActions,
  useConversationSpecialists,
  useConversationTokenEstimates,
  useSpecialistWarningPreferences,
  useAppPreferenceActions,
  useSpecialistStore
} from '@renderer/store'
import { useVoiceInput } from '@renderer/hooks'
import { ConfirmDialog } from '@renderer/components/common'
import CompleteDialog from './CompleteDialog'
import IdeaPopover from './IdeaPopover'
import VoiceIndicator from './VoiceIndicator'
import SpecialistWarningDialog, { type SpecialistWarningType } from './SpecialistWarningDialog'

interface MessageInputProps {
  attachments: string[]
  onClearAttachments: () => void
  onStartGrillMe?: () => Promise<void>
}

const SLASH_COMMANDS: Array<{
  command: string
  description: string
  icon: LucideIcon
  iconColor: string
}> = [
  {
    command: '/complete',
    description: 'Commit changes, push, and close conversation',
    icon: GitPullRequestArrow,
    iconColor: 'text-success'
  },
  {
    command: '/close',
    description: 'Close and delete this conversation',
    icon: X,
    iconColor: 'text-accent'
  },
  {
    command: '/compact',
    description: 'Compress conversation context to save tokens',
    icon: Minimize2,
    iconColor: 'text-warning'
  },
  {
    command: '/clear',
    description: 'Clear chat display (keeps AI context)',
    icon: Trash2,
    iconColor: 'text-danger'
  },
  {
    command: '/grillme',
    description: 'Deep-dive interview to clarify your plan',
    icon: Flame,
    iconColor: 'text-grill'
  },
  {
    command: '/voice',
    description: 'Toggle push-to-talk voice input',
    icon: Mic,
    iconColor: 'text-mode-plan-text'
  },
  {
    command: '/help',
    description: 'Show available commands',
    icon: HelpCircle,
    iconColor: 'text-info'
  }
]

export default function MessageInput({
  attachments,
  onClearAttachments,
  onStartGrillMe
}: MessageInputProps): React.JSX.Element {
  const activeConversation = useChatStore((s) => s.activeConversation)
  const currentConversationId = activeConversation?.id ?? ''
  const draftText = useChatStore((s) => s.draftTexts[currentConversationId] ?? '')
  const { setDraftText, clearDraftText } = useChatActions()
  const [text, setText] = useState(draftText)
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCompleteDialog, setShowCompleteDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const [showSpecialistWarning, setShowSpecialistWarning] = useState(false)
  const [specialistWarningType, setSpecialistWarningType] =
    useState<SpecialistWarningType>('always')
  const [pendingSend, setPendingSend] = useState<{
    content: string
    attachments?: string[]
  } | null>(null)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const {
    sendMessage,
    stopGeneration,
    clearDisplay,
    appendLocalMessage,
    completeConversation,
    closeConversation
  } = useChatActions()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const conversationId = activeConversation?.id
  const conversationSpecialists = useConversationSpecialists(conversationId)
  const conversationTokenEstimates = useConversationTokenEstimates(conversationId)
  const agentStatus = useWorkspaceStore((s) => s.agentStatus)
  const { hydrateConversationSpecialists } = useConversationSpecialistActions()
  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()
  const { loadPreferences } = useAppPreferenceActions()
  const isInitializing = agentStatus === 'starting'
  const workspaceSpecialists = useSpecialistStore((s) => s.specialists)
  const coreSpecialistIds = useMemo(
    () => new Set(workspaceSpecialists.filter((s) => s.isCore).map((s) => s.id)),
    [workspaceSpecialists]
  )
  const activeSpecialistCount = useMemo(
    () =>
      conversationSpecialists.filter(
        (specialist) => specialist.isActive && !coreSpecialistIds.has(specialist.specialistId)
      ).length,
    [conversationSpecialists, coreSpecialistIds]
  )
  const estimatedSpecialistTokens = useMemo(
    () =>
      conversationTokenEstimates.reduce((total, estimate) => total + estimate.estimatedTokens, 0),
    [conversationTokenEstimates]
  )

  // Voice mode state
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [interimText, setInterimText] = useState('')

  const handleTranscript = useCallback((transcript: string) => {
    setText((prev) => {
      const separator = prev.length > 0 && !prev.endsWith(' ') ? ' ' : ''
      return prev + separator + transcript
    })
    setInterimText('')
  }, [])

  const handleInterimTranscript = useCallback((interim: string) => {
    setInterimText(interim)
  }, [])

  const {
    isListening,
    isSupported: isVoiceSupported,
    error: voiceError,
    startListening,
    stopListening,
    clearError: clearVoiceError
  } = useVoiceInput({
    onTranscript: handleTranscript,
    onInterimTranscript: handleInterimTranscript
  })

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      const maxHeight = 6 * 24 // ~6 lines
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    }
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [text, adjustHeight])

  useEffect(() => {
    void loadPreferences().catch(() => undefined)
  }, [loadPreferences])

  useEffect(() => {
    if (!conversationId) return
    void hydrateConversationSpecialists(conversationId).catch(() => undefined)
  }, [conversationId, hydrateConversationSpecialists])

  // Sync local text to draft store (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentConversationId) setDraftText(currentConversationId, text)
    }, 300)
    return () => clearTimeout(timer)
  }, [text, currentConversationId, setDraftText])

  // Restore draft when conversation changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on conversation switch
    setText(useChatStore.getState().draftTexts[currentConversationId] ?? '')
  }, [currentConversationId])

  // Listen for prompt suggestions from SDK
  useEffect(() => {
    const cleanup = window.api.onPromptSuggestion((data) => {
      if (data.conversationId === currentConversationId) {
        setPromptSuggestion(data.suggestion)
      }
    })
    return cleanup
  }, [currentConversationId])

  // Clear suggestion when user starts typing or conversation changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state clear when input changes
    if (text) setPromptSuggestion(null)
  }, [text])

  // Slash command filtering
  const filteredCommands = useMemo(() => {
    if (!text.startsWith('/')) return []
    const typed = text.split(' ')[0].toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(typed))
  }, [text])

  const showCommands = text.startsWith('/') && filteredCommands.length > 0

  // Push-to-talk keyboard shortcut: hold V when input not focused
  useEffect(() => {
    if (!voiceEnabled || !isVoiceSupported) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.code === 'KeyV' &&
        !e.repeat &&
        document.activeElement !== textareaRef.current &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        startListening()
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'KeyV' && isListening) {
        e.preventDefault()
        stopListening()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [voiceEnabled, isVoiceSupported, isListening, startListening, stopListening])

  const getWarningTypeForCurrentMode = useCallback((): SpecialistWarningType | null => {
    if (!activeConversation || activeSpecialistCount === 0) return null
    if (specialistWarningAlways) return 'always'
    if (activeConversation.mode === 'build' && specialistWarningBuild) return 'build'
    if (activeConversation.mode === 'plan' && specialistWarningPlan) return 'plan'
    return null
  }, [
    activeConversation,
    activeSpecialistCount,
    specialistWarningAlways,
    specialistWarningBuild,
    specialistWarningPlan
  ])

  const executeSend = useCallback(
    async (content: string, sendAttachments?: string[]): Promise<void> => {
      setText('')
      if (currentConversationId) clearDraftText(currentConversationId)
      onClearAttachments()
      await sendMessage(content, sendAttachments)
    },
    [onClearAttachments, sendMessage, currentConversationId, clearDraftText]
  )

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !activeConversation) return

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      const cmd = trimmed.split(' ')[0].toLowerCase()

      if (cmd === '/complete') {
        setText('')
        setShowCompleteDialog(true)
        return
      }

      if (cmd === '/close') {
        setText('')
        setShowCloseConfirm(true)
        return
      }

      if (cmd === '/compact') {
        setText('')
        onClearAttachments()
        const extractNuance = trimmed.toLowerCase().includes('--nuance')
        try {
          await window.api.compactConversation({ extractNuance })
        } catch (err) {
          appendLocalMessage(
            `**Compact failed:** ${err instanceof Error ? err.message : String(err)}`
          )
        }
        return
      }

      if (cmd === '/clear') {
        setText('')
        clearDisplay()
        return
      }

      if (cmd === '/grillme') {
        setText('')
        if (onStartGrillMe) {
          await onStartGrillMe()
        }
        return
      }

      if (cmd === '/voice') {
        setText('')
        if (!isVoiceSupported) {
          appendLocalMessage(
            '**Voice input is not supported** in this environment. Speech recognition requires a Chromium-based runtime with internet access.'
          )
          return
        }
        const newState = !voiceEnabled
        setVoiceEnabled(newState)
        appendLocalMessage(
          newState
            ? '**Voice mode enabled.** Hold the mic button or press `V` (when input is not focused) to speak. Release to insert transcribed text.'
            : '**Voice mode disabled.**'
        )
        return
      }

      if (cmd === '/help') {
        setText('')
        const helpLines = [
          '**`/complete`** — Commit tracked changes, push, and close conversation',
          '**`/close`** — Close and permanently delete this conversation',
          '**`/compact`** — Compress conversation context to save tokens',
          '**`/clear`** — Clear chat display (keeps AI context)',
          '**`/grillme`** — Deep-dive interview to clarify your plan',
          '**`/voice`** — Toggle push-to-talk voice input',
          '**`/help`** — Show available commands'
        ]
        appendLocalMessage(`### Available Commands\n\n${helpLines.join('\n')}`)
        return
      }
    }

    const warningType = getWarningTypeForCurrentMode()
    if (warningType) {
      setSpecialistWarningType(warningType)
      setPendingSend({
        content: trimmed,
        attachments: attachments.length > 0 ? [...attachments] : undefined
      })
      setShowSpecialistWarning(true)
      return
    }

    await executeSend(trimmed, attachments.length > 0 ? attachments : undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Handle command autocomplete navigation
    if (showCommands) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedCommandIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedCommandIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const selected = filteredCommands[selectedCommandIndex]
        if (selected) {
          setText(selected.command)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setText('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const isDisabled = isStreaming || !activeConversation || isInitializing

  return (
    <>
      {/* Voice recording indicator */}
      {voiceEnabled && (
        <VoiceIndicator
          isListening={isListening}
          interimText={interimText}
          error={voiceError}
          onDismissError={clearVoiceError}
        />
      )}

      {/* Prompt suggestion chip — positioned above input for visibility */}
      {promptSuggestion && !isStreaming && (
        <div className="mb-1.5">
          <button
            onClick={() => {
              sendMessage(promptSuggestion)
              setPromptSuggestion(null)
            }}
            className="text-xs text-primary-text bg-primary/10 px-3 py-1 rounded-full hover:bg-primary/20 transition-colors"
            title={promptSuggestion}
          >
            💡{' '}
            {promptSuggestion.length > 80
              ? promptSuggestion.slice(0, 77) + '...'
              : promptSuggestion}
          </button>
        </div>
      )}

      <div className="relative flex-1 min-w-0 flex items-end gap-2">
        {/* Slash command autocomplete dropdown */}
        {showCommands && (
          <div className="absolute bottom-full mb-1 left-0 bg-surface-float rounded-lg border border-border-default py-1.5 w-96 shadow-xl z-50">
            {filteredCommands.map((cmd, index) => {
              const Icon = cmd.icon
              return (
                <button
                  key={cmd.command}
                  onClick={() => {
                    setText(cmd.command)
                    textareaRef.current?.focus()
                  }}
                  className={`w-full text-left px-4 py-2.5 text-base transition-colors flex items-center gap-3 ${
                    index === selectedCommandIndex
                      ? 'bg-surface-overlay text-text-primary'
                      : 'hover:bg-surface-overlay/50 text-text-body'
                  }`}
                >
                  <Icon size={18} className={`${cmd.iconColor} flex-shrink-0`} />
                  <span className="text-primary-text font-mono text-sm font-medium w-28 flex-shrink-0">
                    {cmd.command}
                  </span>
                  <span className="text-text-secondary text-sm">{cmd.description}</span>
                </button>
              )
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSelectedCommandIndex(0)
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            isInitializing
              ? 'Waiting for AI agent to initialize...'
              : !activeConversation
                ? 'Select or create a conversation...'
                : activeConversation.mode === 'plan'
                  ? `Ask anything — type / for commands, ${navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'} to switch mode...`
                  : `Describe what to build — type / for commands, ${navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'} to switch mode...`
          }
          disabled={isDisabled}
          rows={1}
          className="flex-1 bg-transparent text-text-body placeholder-text-muted resize-none outline-none text-sm leading-relaxed py-2 disabled:opacity-50"
          aria-label="Message input"
        />

        {/* Stop button — visible when streaming */}
        {isStreaming && (
          <button
            onClick={() => setShowStopConfirm(true)}
            className="flex-shrink-0 p-2 rounded-lg bg-danger text-white hover:brightness-110 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base press-scale"
            aria-label="Stop generation"
            title="Stop generation"
          >
            <Square size={18} />
          </button>
        )}

        {/* Idea capture button */}
        <button
          onClick={() => setShowIdeaPopover(!showIdeaPopover)}
          disabled={!activeConversation}
          className="flex-shrink-0 p-2 rounded-lg text-warning hover:bg-warning-muted disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          aria-label="Capture an idea"
          title="Capture an idea"
        >
          <Lightbulb size={18} />
        </button>

        {/* Idea popover */}
        {showIdeaPopover && (
          <IdeaPopover
            onClose={() => setShowIdeaPopover(false)}
            onSaved={() => setText('')}
            initialTitle={text.trim()}
          />
        )}

        {/* Voice mic button — visible when voice mode enabled */}
        {voiceEnabled && isVoiceSupported && (
          <button
            onMouseDown={(e) => {
              e.preventDefault() // Prevent textarea blur
              startListening()
            }}
            onMouseUp={stopListening}
            onMouseLeave={() => {
              if (isListening) stopListening()
            }}
            disabled={isDisabled}
            className={`flex-shrink-0 p-2 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base ${
              isListening
                ? 'bg-danger-muted text-danger ring-2 ring-danger/40 animate-pulse focus-visible:ring-danger'
                : 'text-mode-plan-text hover:bg-mode-plan-muted disabled:opacity-30 focus-visible:ring-mode-plan'
            }`}
            aria-label={isListening ? 'Release to stop recording' : 'Hold to speak'}
            title={isListening ? 'Release to stop recording' : 'Hold to speak (or hold V key)'}
          >
            {isListening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={isDisabled || !text.trim()}
          className="flex-shrink-0 p-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-30 disabled:hover:bg-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base press-scale"
          aria-label="Send message (Enter)"
          title="Send message (Enter)"
        >
          <Send size={18} />
        </button>
      </div>

      <ConfirmDialog
        isOpen={showStopConfirm}
        title="Stop Generation"
        message="Are you sure you want to stop the current response? The AI will stop generating immediately."
        confirmLabel="Stop"
        cancelLabel="Continue"
        variant="danger"
        onConfirm={async () => {
          await stopGeneration()
          setShowStopConfirm(false)
        }}
        onCancel={() => setShowStopConfirm(false)}
      />

      {/* /complete dialog */}
      <CompleteDialog
        isOpen={showCompleteDialog}
        conversationTitle={activeConversation?.title ?? 'Untitled'}
        conversationId={activeConversation?.id ?? ''}
        onConfirm={async (branchName, commitMessage, description) => {
          await completeConversation(branchName, commitMessage, description)
          setShowCompleteDialog(false)
        }}
        onCancel={() => setShowCompleteDialog(false)}
      />

      {/* /close confirmation */}
      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Close Conversation"
        message="This will permanently delete this conversation, all messages, and tracked file changes. Uncommitted changes in your workspace will NOT be affected."
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          if (activeConversation) {
            await closeConversation(activeConversation.id)
          }
          setShowCloseConfirm(false)
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />

      <SpecialistWarningDialog
        isOpen={showSpecialistWarning}
        warningType={specialistWarningType}
        activeSpecialistCount={activeSpecialistCount}
        estimatedTokens={estimatedSpecialistTokens}
        onCancel={() => {
          setShowSpecialistWarning(false)
          setPendingSend(null)
        }}
        onConfirm={() => {
          // Close dialog immediately — don't await the send
          const pending = pendingSend
          setShowSpecialistWarning(false)
          setPendingSend(null)
          if (pending) {
            void executeSend(pending.content, pending.attachments)
          }
        }}
      />
    </>
  )
}

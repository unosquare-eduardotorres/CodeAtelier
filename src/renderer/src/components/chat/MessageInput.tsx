import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Send, Square, Lightbulb, Mic, MicOff } from 'lucide-react'
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
import IdeaPopover from './IdeaPopover'
import VoiceIndicator from './VoiceIndicator'
import {
  SlashCommandDropdown,
  MessageInputDialogs,
  usePushToTalk,
  useSlashCommands,
  useDraftText,
  useSpecialistWarningFlow
} from './message-input'

interface MessageInputProps {
  attachments: string[]
  onClearAttachments: () => void
  onStartGrillMe?: () => Promise<void>
}

export default function MessageInput({
  attachments,
  onClearAttachments,
  onStartGrillMe
}: MessageInputProps): React.JSX.Element {
  const activeConversation = useChatStore((s) => s.activeConversation)
  const currentConversationId = activeConversation?.id ?? ''
  const { clearDraftText } = useChatActions()
  const { text, setText } = useDraftText(currentConversationId)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCompleteDialog, setShowCompleteDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showRewindDialog, setShowRewindDialog] = useState(false)
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const {
    sendMessage,
    stopGeneration,
    clearDisplay,
    appendLocalMessage,
    completeConversation,
    closeConversation,
    setEffort
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

  // ── Voice input ──
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

  // Push-to-talk V key shortcut
  usePushToTalk({
    voiceEnabled,
    isVoiceSupported,
    isListening,
    startListening,
    stopListening,
    textareaRef
  })

  // ── Textarea auto-resize ──
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

  // ── Slash commands ──
  const currentProvider = activeConversation?.llmProvider ?? 'claude'
  const {
    executeCommand,
    filteredCommands,
    showCommands,
    selectedCommandIndex,
    setSelectedCommandIndex
  } = useSlashCommands({
    text,
    currentConversationId,
    currentProvider,
    voiceEnabled,
    isVoiceSupported,
    onClearAttachments,
    setShowCompleteDialog,
    setShowCloseConfirm,
    setShowRewindDialog,
    setVoiceEnabled,
    appendLocalMessage,
    clearDisplay,
    sendMessage,
    setEffort,
    onStartGrillMe
  })

  // ── Send logic ──
  const executeSend = useCallback(
    async (content: string, sendAttachments?: string[]): Promise<void> => {
      setText('')
      if (currentConversationId) clearDraftText(currentConversationId)
      onClearAttachments()
      await sendMessage(content, sendAttachments)
    },
    [setText, onClearAttachments, sendMessage, currentConversationId, clearDraftText]
  )

  // ── Specialist warning flow ──
  const {
    checkWarning,
    showSpecialistWarning,
    specialistWarningType,
    cancelWarning,
    confirmWarning
  } = useSpecialistWarningFlow({
    activeConversation,
    activeSpecialistCount,
    specialistWarningAlways,
    specialistWarningBuild,
    specialistWarningPlan,
    executeSend
  })

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !activeConversation) return

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      setText('')
      await executeCommand(trimmed)
      return
    }

    // Check if specialist warning should block this send
    const sendAttachments = attachments.length > 0 ? [...attachments] : undefined
    if (checkWarning(trimmed, sendAttachments)) return

    await executeSend(trimmed, sendAttachments)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
        if (selected) setText(selected.command)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setText('')
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const selected = filteredCommands[selectedCommandIndex]
        if (selected) {
          setText(selected.command)
          void executeCommand(selected.command)
        }
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

      <div className="relative flex-1 min-w-0 flex items-end gap-2">
        {/* Slash command autocomplete dropdown */}
        {showCommands && (
          <SlashCommandDropdown
            commands={filteredCommands}
            selectedIndex={selectedCommandIndex}
            onSelect={(command) => {
              setText(command)
              void executeCommand(command)
              textareaRef.current?.focus()
            }}
          />
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
                : activeConversation.mode === 'danger'
                  ? `⚠️ Danger mode — all commands execute without checks. ${navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'} to switch mode...`
                  : activeConversation.mode === 'plan'
                    ? `Ask anything — type / for commands, ${navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'} to switch mode...`
                    : `Describe what to build — type / for commands, ${navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'} to switch mode...`
          }
          disabled={isDisabled}
          rows={1}
          className="flex-1 bg-transparent text-text-body placeholder-text-muted resize-none outline-none text-sm leading-relaxed py-2 disabled:opacity-50"
          aria-label="Message input"
        />

        {/* Stop button */}
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

        {showIdeaPopover && (
          <IdeaPopover
            onClose={() => setShowIdeaPopover(false)}
            onSaved={() => setText('')}
            initialTitle={text.trim()}
          />
        )}

        {/* Voice mic button */}
        {voiceEnabled && isVoiceSupported && (
          <button
            onMouseDown={(e) => {
              e.preventDefault()
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

      <MessageInputDialogs
        showStopConfirm={showStopConfirm}
        onStopConfirm={async () => {
          await stopGeneration()
          setShowStopConfirm(false)
        }}
        onStopCancel={() => setShowStopConfirm(false)}
        showCompleteDialog={showCompleteDialog}
        conversationTitle={activeConversation?.title ?? 'Untitled'}
        conversationId={activeConversation?.id ?? ''}
        onCompleteConfirm={async (branchName, commitMessage, description) => {
          await completeConversation(branchName, commitMessage, description)
          setShowCompleteDialog(false)
        }}
        onCompleteCancel={() => setShowCompleteDialog(false)}
        showCloseConfirm={showCloseConfirm}
        onCloseConfirm={async () => {
          if (activeConversation) {
            await closeConversation(activeConversation.id)
          }
          setShowCloseConfirm(false)
        }}
        onCloseCancel={() => setShowCloseConfirm(false)}
        showRewindDialog={showRewindDialog}
        onRewindCancel={() => setShowRewindDialog(false)}
        onRewindComplete={() => setShowRewindDialog(false)}
        showSpecialistWarning={showSpecialistWarning}
        specialistWarningType={specialistWarningType}
        activeSpecialistCount={activeSpecialistCount}
        estimatedSpecialistTokens={estimatedSpecialistTokens}
        onSpecialistWarningCancel={cancelWarning}
        onSpecialistWarningConfirm={confirmWarning}
      />
    </>
  )
}

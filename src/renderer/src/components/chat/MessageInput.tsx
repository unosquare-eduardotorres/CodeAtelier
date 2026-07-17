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
  useSpecialistWarningFlow,
  useInputHistory
} from './message-input'

// ─── Pure Helpers ─────────────────────────────────────────

/** Build placeholder text based on conversation state. */
function getPlaceholderText(
  isInitializing: boolean,
  activeConversation: { mode?: string } | null
): string {
  if (isInitializing) return 'Waiting for AI agent to initialize...'
  if (!activeConversation) return 'Select or create a conversation...'
  const shortcut = navigator.platform.toUpperCase().includes('MAC') ? '⌘.' : 'Ctrl+.'
  if (activeConversation.mode === 'danger') {
    return `⚠️ Danger mode — all commands execute without checks. ${shortcut} to switch mode...`
  }
  const prefix = activeConversation.mode === 'plan' ? 'Ask anything' : 'Describe what to build'
  return `${prefix} — type / for commands, ${shortcut} to switch mode...`
}

/** Append text with a space separator when needed. */
function appendWithSeparator(existing: string, addition: string): string {
  const separator = existing.length > 0 && !existing.endsWith(' ') ? ' ' : ''
  return existing + separator + addition
}

// ─── Command Key Dispatch ─────────────────────────────────

interface CommandContext {
  filteredCommands: { command: string }[]
  selectedCommandIndex: number
  setSelectedCommandIndex: React.Dispatch<React.SetStateAction<number>>
  setText: (value: string) => void
  executeCommand: (command: string) => Promise<boolean>
}

/**
 * Dispatch slash-command navigation keys when the dropdown is visible.
 * Returns true if the key was consumed, false to fall through.
 */
function handleCommandKey(e: React.KeyboardEvent, ctx: CommandContext): boolean {
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      ctx.setSelectedCommandIndex((prev) =>
        prev > 0 ? prev - 1 : ctx.filteredCommands.length - 1
      )
      return true
    case 'ArrowDown':
      e.preventDefault()
      ctx.setSelectedCommandIndex((prev) =>
        prev < ctx.filteredCommands.length - 1 ? prev + 1 : 0
      )
      return true
    case 'Tab': {
      e.preventDefault()
      const selected = ctx.filteredCommands[ctx.selectedCommandIndex]
      if (selected) ctx.setText(selected.command)
      return true
    }
    case 'Escape':
      e.preventDefault()
      ctx.setText('')
      return true
    case 'Enter': {
      if (e.shiftKey) return false
      e.preventDefault()
      const selected = ctx.filteredCommands[ctx.selectedCommandIndex]
      if (selected) {
        ctx.setText(selected.command)
        void ctx.executeCommand(selected.command)
      }
      return true
    }
    default:
      return false
  }
}

// ─── Voice Mic Button ─────────────────────────────────────

function VoiceMicButton({
  isListening,
  isDisabled,
  startListening,
  stopListening
}: {
  isListening: boolean
  isDisabled: boolean
  startListening: () => void
  stopListening: () => void
}): React.JSX.Element {
  return (
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
  )
}

// ─── Dialog State Hook ────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred hook return type is complex
function useMessageInputDialogs(activeConversation: { id?: string; title?: string } | null) {
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCompleteDialog, setShowCompleteDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showRewindDialog, setShowRewindDialog] = useState(false)
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const { stopGeneration, completeConversation, closeConversation } = useChatActions()

  const handleStopConfirm = useCallback(async () => {
    await stopGeneration()
    setShowStopConfirm(false)
  }, [stopGeneration])

  const handleCompleteConfirm = useCallback(
    async (branchName: string, commitMessage: string, description: string) => {
      await completeConversation(branchName, commitMessage, description)
      setShowCompleteDialog(false)
    },
    [completeConversation]
  )

  const handleCloseConfirm = useCallback(async () => {
    if (activeConversation) {
      await closeConversation(activeConversation.id!)
    }
    setShowCloseConfirm(false)
  }, [activeConversation, closeConversation])

  return {
    showStopConfirm,
    setShowStopConfirm,
    showCompleteDialog,
    setShowCompleteDialog,
    showCloseConfirm,
    setShowCloseConfirm,
    showRewindDialog,
    setShowRewindDialog,
    showIdeaPopover,
    setShowIdeaPopover,
    handleStopConfirm,
    handleStopCancel: useCallback(() => setShowStopConfirm(false), []),
    conversationTitle: activeConversation?.title ?? 'Untitled',
    dialogConversationId: activeConversation?.id ?? '',
    handleCompleteConfirm,
    handleCompleteCancel: useCallback(() => setShowCompleteDialog(false), []),
    handleCloseConfirm,
    handleCloseCancel: useCallback(() => setShowCloseConfirm(false), []),
    handleRewindCancel: useCallback(() => setShowRewindDialog(false), []),
    handleRewindComplete: useCallback(() => setShowRewindDialog(false), [])
  }
}

// ─── useMessageSubmit Hook ────────────────────────────────

function useMessageSubmit(params: {
  text: string
  setText: (val: string) => void
  attachments: string[]
  activeConversation: { id?: string } | null
  executeCommand: (command: string) => Promise<boolean>
  checkWarning: (text: string, attachments?: string[]) => boolean
  executeSend: (content: string, sendAttachments?: string[]) => Promise<void>
}): () => Promise<void> {
  const { text, setText, attachments, activeConversation, executeCommand, checkWarning, executeSend } = params

  return useCallback(async (): Promise<void> => {
    const trimmed = text.trim()
    // SEND-RACE-01: Read live store state (not stale React closure) to prevent
    // rapid double-clicks from bypassing the guard between render cycles.
    const { isStreaming: liveStreaming, isSending } = useChatStore.getState()
    if (!trimmed || liveStreaming || isSending || !activeConversation) return

    if (trimmed.startsWith('/')) {
      setText('')
      await executeCommand(trimmed)
      return
    }

    const sendAttachments = attachments.length > 0 ? [...attachments] : undefined
    if (checkWarning(trimmed, sendAttachments)) return

    await executeSend(trimmed, sendAttachments)
  }, [text, setText, attachments, activeConversation, executeCommand, checkWarning, executeSend])
}

// ─── useMessageInputEffects Hook ─────────────────────────

function useMessageInputEffects(
  text: string,
  conversationId: string | undefined,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  loadPreferences: () => Promise<void>,
  hydrateConversationSpecialists: (id: string) => Promise<void>
): void {
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      const maxHeight = 6 * 24 // ~6 lines
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    }
  }, [textareaRef])

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
}

// ─── Component ────────────────────────────────────────────

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
  const { clearDraftText, sendMessage, appendLocalMessage, clearDisplay, setEffort } =
    useChatActions()
  const { text, setText } = useDraftText(currentConversationId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const conversationId = activeConversation?.id

  // ── Message history navigation (ArrowUp/Down) ──
  const { handleHistoryKey, resetHistory } = useInputHistory({
    text,
    setText,
    textareaRef,
    conversationId
  })
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

  // ── Dialogs ──
  const dialogs = useMessageInputDialogs(activeConversation)

  // ── Voice input ──
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [interimText, setInterimText] = useState('')

  const handleTranscript = useCallback((transcript: string) => {
    setText((prev) => appendWithSeparator(prev, transcript))
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

  // ── Side effects ──
  useMessageInputEffects(text, conversationId, textareaRef, loadPreferences, hydrateConversationSpecialists)

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
    setShowCompleteDialog: dialogs.setShowCompleteDialog,
    setShowCloseConfirm: dialogs.setShowCloseConfirm,
    setShowRewindDialog: dialogs.setShowRewindDialog,
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

  const handleSend = useMessageSubmit({
    text,
    setText,
    attachments,
    activeConversation,
    executeCommand,
    checkWarning,
    executeSend
  })

  const commandCtx: CommandContext = {
    filteredCommands,
    selectedCommandIndex,
    setSelectedCommandIndex,
    setText,
    executeCommand
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showCommands && handleCommandKey(e, commandCtx)) return
    if (handleHistoryKey(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      resetHistory()
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
            resetHistory()
          }}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholderText(isInitializing, activeConversation)}
          disabled={isDisabled}
          rows={1}
          className="flex-1 bg-transparent text-text-body placeholder-text-muted resize-none outline-none text-sm leading-relaxed py-2 disabled:opacity-50"
          aria-label="Message input"
        />

        {/* Stop button */}
        {isStreaming && (
          <button
            onClick={() => dialogs.setShowStopConfirm(true)}
            className="flex-shrink-0 p-2 rounded-lg bg-danger text-white hover:brightness-110 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base press-scale"
            aria-label="Stop generation"
            title="Stop generation"
          >
            <Square size={18} />
          </button>
        )}

        {/* Idea capture button */}
        <button
          onClick={() => dialogs.setShowIdeaPopover(!dialogs.showIdeaPopover)}
          disabled={!activeConversation}
          className="flex-shrink-0 p-2 rounded-lg text-warning hover:bg-warning-muted disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          aria-label="Capture an idea"
          title="Capture an idea"
        >
          <Lightbulb size={18} />
        </button>

        {dialogs.showIdeaPopover && (
          <IdeaPopover
            onClose={() => dialogs.setShowIdeaPopover(false)}
            onSaved={() => setText('')}
            initialTitle={text.trim()}
          />
        )}

        {/* Voice mic button */}
        {voiceEnabled && isVoiceSupported && (
          <VoiceMicButton
            isListening={isListening}
            isDisabled={isDisabled}
            startListening={startListening}
            stopListening={stopListening}
          />
        )}

        {/* Send button */}
        <button
          onClick={() => {
            resetHistory()
            void handleSend()
          }}
          disabled={isDisabled || !text.trim()}
          className="flex-shrink-0 p-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-30 disabled:hover:bg-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base press-scale"
          aria-label="Send message (Enter)"
          title="Send message (Enter)"
        >
          <Send size={18} />
        </button>
      </div>

      <MessageInputDialogs
        showStopConfirm={dialogs.showStopConfirm}
        onStopConfirm={dialogs.handleStopConfirm}
        onStopCancel={dialogs.handleStopCancel}
        showCompleteDialog={dialogs.showCompleteDialog}
        conversationTitle={dialogs.conversationTitle}
        conversationId={dialogs.dialogConversationId}
        onCompleteConfirm={dialogs.handleCompleteConfirm}
        onCompleteCancel={dialogs.handleCompleteCancel}
        showCloseConfirm={dialogs.showCloseConfirm}
        onCloseConfirm={dialogs.handleCloseConfirm}
        onCloseCancel={dialogs.handleCloseCancel}
        showRewindDialog={dialogs.showRewindDialog}
        onRewindCancel={dialogs.handleRewindCancel}
        onRewindComplete={dialogs.handleRewindComplete}
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

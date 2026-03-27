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
  Lightbulb
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useChatStore, useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog } from '@renderer/components/common'
import CompleteDialog from './CompleteDialog'
import IdeaPopover from './IdeaPopover'

interface MessageInputProps {
  attachments: string[]
  onClearAttachments: () => void
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
    iconColor: 'text-green-400'
  },
  {
    command: '/close',
    description: 'Close and delete this conversation',
    icon: X,
    iconColor: 'text-orange-400'
  },
  {
    command: '/compact',
    description: 'Compress conversation context to save tokens',
    icon: Minimize2,
    iconColor: 'text-amber-400'
  },
  {
    command: '/clear',
    description: 'Clear chat display (keeps AI context)',
    icon: Trash2,
    iconColor: 'text-red-400'
  },
  {
    command: '/grillme',
    description: 'Deep-dive interview to clarify your plan',
    icon: Flame,
    iconColor: 'text-orange-500'
  },
  {
    command: '/help',
    description: 'Show available commands',
    icon: HelpCircle,
    iconColor: 'text-blue-400'
  }
]

export default function MessageInput({
  attachments,
  onClearAttachments
}: MessageInputProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCompleteDialog, setShowCompleteDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showIdeaPopover, setShowIdeaPopover] = useState(false)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const {
    sendMessage,
    isStreaming,
    activeConversation,
    stopGeneration,
    clearDisplay,
    appendLocalMessage,
    completeConversation,
    closeConversation,
    startGrillSession
  } = useChatStore()
  const { orchestratorStatus } = useWorkspaceStore()
  const isInitializing = orchestratorStatus === 'starting'

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

  // Slash command filtering
  const filteredCommands = useMemo(() => {
    if (!text.startsWith('/')) return []
    const typed = text.split(' ')[0].toLowerCase()
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(typed))
  }, [text])

  const showCommands = text.startsWith('/') && filteredCommands.length > 0

  // Reset selected index when filtered commands change
  useEffect(() => {
    setSelectedCommandIndex(0)
  }, [filteredCommands.length])

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
        await sendMessage(trimmed, attachments.length > 0 ? attachments : undefined)
        onClearAttachments()
        return
      }

      if (cmd === '/clear') {
        setText('')
        clearDisplay()
        return
      }

      if (cmd === '/grillme') {
        setText('')
        startGrillSession()
        const grillPrompt = `[GRILL MODE ACTIVATED]\n\nInterview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. If a question can be answered by exploring the codebase, explore the codebase instead.\n\nReview the conversation above and start grilling me about the items, pending decisions, and unclear requirements.`
        await sendMessage(grillPrompt, attachments.length > 0 ? attachments : undefined)
        onClearAttachments()
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
          '**`/help`** — Show available commands'
        ]
        appendLocalMessage(`### Available Commands\n\n${helpLines.join('\n')}`)
        return
      }
    }

    setText('')
    await sendMessage(trimmed, attachments.length > 0 ? attachments : undefined)
    onClearAttachments()
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
                  <Icon size={18} className={cmd.iconColor} />
                  <span className="text-primary-text font-mono text-sm font-medium">
                    {cmd.command}
                  </span>
                  <span className="text-text-secondary ml-auto text-sm">{cmd.description}</span>
                </button>
              )
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
            className="flex-shrink-0 p-2 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base press-scale"
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
          className="flex-shrink-0 p-2 rounded-lg text-yellow-400 hover:bg-yellow-500/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          aria-label="Capture an idea"
          title="Capture an idea"
        >
          <Lightbulb size={18} />
        </button>

        {/* Idea popover */}
        {showIdeaPopover && <IdeaPopover onClose={() => setShowIdeaPopover(false)} />}

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
    </>
  )
}

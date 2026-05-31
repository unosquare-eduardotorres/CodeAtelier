/**
 * useSlashCommands — Slash command registry, filtering, and execution.
 *
 * Extracted from MessageInput to reduce its complexity (~180 LOC).
 * Converts the original 12-branch if-chain into a data-driven command registry.
 */

import { useState, useMemo, useCallback } from 'react'
import {
  Send,
  Minimize2,
  Trash2,
  HelpCircle,
  GitPullRequestArrow,
  X,
  Flame,
  Landmark,
  Mic,
  Gauge,
  ClipboardCheck,
  Undo2,
  History,
  ScrollText
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTodoStore } from '@renderer/store/todo.store'
import type { ThinkingEffort, LLMProvider } from '../../../../../shared/types'

// ── Types ──

export interface SlashCommand {
  command: string
  description: string
  icon: LucideIcon
  iconColor: string
  /** If set, only show this command for these LLM providers. Omit = universal. */
  providers?: LLMProvider[]
}

interface UseSlashCommandsOptions {
  text: string
  currentConversationId: string
  currentProvider: LLMProvider
  voiceEnabled: boolean
  isVoiceSupported: boolean
  onClearAttachments: () => void
  setShowCompleteDialog: (v: boolean) => void
  setShowCloseConfirm: (v: boolean) => void
  setShowRewindDialog: (v: boolean) => void
  setVoiceEnabled: (v: boolean) => void
  appendLocalMessage: (msg: string) => void
  clearDisplay: () => void
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  setEffort: (conversationId: string, effort: ThinkingEffort) => void
  onStartGrillMe?: () => Promise<void>
}

export interface UseSlashCommandsResult {
  /** Execute a slash command string. Returns true if a command was matched. */
  executeCommand: (commandText: string) => Promise<boolean>
  /** Commands matching the current text input, filtered by provider. */
  filteredCommands: SlashCommand[]
  /** Whether the slash command dropdown should be visible. */
  showCommands: boolean
  /** Currently selected index in the dropdown. */
  selectedCommandIndex: number
  setSelectedCommandIndex: (index: number) => void
  /** Full command list (for external use). */
  SLASH_COMMANDS: readonly SlashCommand[]
}

// ── Command definitions (static — shared across all instances) ──

const SLASH_COMMANDS: readonly SlashCommand[] = [
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
    command: '/effort',
    description: 'Set thinking depth (low / medium / high)',
    icon: Gauge,
    iconColor: 'text-purple-400'
  },
  {
    command: '/todos',
    description: 'Show/hide agent task list',
    icon: ClipboardCheck,
    iconColor: 'text-cyan-400'
  },
  {
    command: '/voice',
    description: 'Toggle push-to-talk voice input',
    icon: Mic,
    iconColor: 'text-mode-plan-text'
  },
  {
    command: '/undo',
    description: 'Undo last build changes (git restore)',
    icon: Undo2,
    iconColor: 'text-warning'
  },
  {
    command: '/rewind',
    description: 'Rewind to a checkpoint (undo code + messages)',
    icon: History,
    iconColor: 'text-orange-400'
  },
  {
    command: '/recap',
    description: 'Summarize what was done in this conversation',
    icon: ScrollText,
    iconColor: 'text-blue-400'
  },
  {
    command: '/council',
    description: 'Run the LLM Council — 5 advisors review your plan or question',
    icon: Landmark,
    iconColor: 'text-purple-400'
  },
  {
    command: '/help',
    description: 'Show available commands',
    icon: HelpCircle,
    iconColor: 'text-info'
  }
] as const

// Extended help descriptions for /help output
const HELP_DESCRIPTIONS: Record<string, string> = {
  '/complete': 'Commit tracked changes, push, and close conversation',
  '/close': 'Close and permanently delete this conversation',
  '/compact': 'Compress conversation context to save tokens',
  '/clear': 'Clear chat display (keeps AI context)',
  '/effort': 'Set thinking depth — `/effort low` | `/effort medium` | `/effort high`',
  '/todos': 'Show/hide agent task list',
  '/grillme': 'Deep-dive interview to clarify your plan',
  '/voice': 'Toggle push-to-talk voice input',
  '/undo': 'Undo last build changes — reverts files to the previous checkpoint',
  '/rewind':
    'Rewind to a previous checkpoint — reverts code AND removes messages after that point',
  '/recap': 'Get a summary of what was done in this conversation',
  '/council': 'Run the LLM Council — 5 independent AI advisors review and cross-examine your plan',
  '/help': 'Show available commands'
}

// ── Hook ──

export function useSlashCommands(opts: UseSlashCommandsOptions): UseSlashCommandsResult {
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)

  // Filter commands matching the current text prefix, scoped to current provider
  const filteredCommands = useMemo(() => {
    if (!opts.text.startsWith('/')) return []
    const typed = opts.text.split(' ')[0].toLowerCase()
    return SLASH_COMMANDS.filter((c) => {
      if (!c.command.startsWith(typed)) return false
      if (c.providers && !c.providers.includes(opts.currentProvider)) return false
      return true
    }) as SlashCommand[]
  }, [opts.text, opts.currentProvider])

  const showCommands = opts.text.startsWith('/') && filteredCommands.length > 0

  // ── Command handlers (data-driven registry) ──
  const executeCommand = useCallback(
    async (commandText: string): Promise<boolean> => {
      const trimmed = commandText.trim()
      const cmd = trimmed.split(' ')[0].toLowerCase()

      // Command registry — each entry maps a slash command to its handler
      const handlers: Record<string, () => Promise<void> | void> = {
        '/complete': () => opts.setShowCompleteDialog(true),
        '/close': () => opts.setShowCloseConfirm(true),

        '/compact': async () => {
          opts.onClearAttachments()
          const extractNuance = trimmed.toLowerCase().includes('--nuance')
          try {
            await window.api.compactConversation({ extractNuance })
          } catch (err) {
            opts.appendLocalMessage(
              `**Compact failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        },

        '/clear': () => opts.clearDisplay(),

        '/grillme': async () => {
          if (opts.onStartGrillMe) await opts.onStartGrillMe()
        },

        '/effort': async () => {
          const arg = trimmed.split(' ')[1]?.toLowerCase()
          const validEfforts: ThinkingEffort[] = ['low', 'medium', 'high']
          if (arg && validEfforts.includes(arg as ThinkingEffort)) {
            const effort = arg as ThinkingEffort
            await window.api.updateEffort({
              conversationId: opts.currentConversationId,
              effort
            })
            opts.setEffort(opts.currentConversationId, effort)
            opts.appendLocalMessage(`Thinking effort set to **${effort}**`)
          } else {
            opts.appendLocalMessage(
              'Usage: `/effort low` | `/effort medium` | `/effort high`'
            )
          }
        },

        '/todos': () => {
          const { toggleExpanded, todos } = useTodoStore.getState()
          const convTodos = todos[opts.currentConversationId] ?? []
          if (convTodos.length === 0) {
            opts.appendLocalMessage(
              'No tasks in this conversation yet. The agent creates tasks automatically during multi-step work.'
            )
          } else {
            toggleExpanded()
          }
        },

        '/voice': () => {
          if (!opts.isVoiceSupported) {
            opts.appendLocalMessage(
              '**Voice input is not supported** in this environment. Speech recognition requires a Chromium-based runtime with internet access.'
            )
            return
          }
          const newState = !opts.voiceEnabled
          opts.setVoiceEnabled(newState)
          opts.appendLocalMessage(
            newState
              ? '**Voice mode enabled.** Hold the mic button or press `V` (when input is not focused) to speak. Release to insert transcribed text.'
              : '**Voice mode disabled.**'
          )
        },

        '/undo': async () => {
          try {
            const checkpoints = await window.api.listCheckpoints({
              conversationId: opts.currentConversationId
            })
            if (checkpoints.length === 0) {
              opts.appendLocalMessage(
                '**Undo failed:** No checkpoints found for this conversation. Undo requires at least one build execution with tracked changes.'
              )
              return
            }
            const latestCheckpoint = checkpoints[checkpoints.length - 1]
            const result = await window.api.restoreCheckpoint({
              checkpointId: latestCheckpoint.id
            })
            if (result.success) {
              opts.appendLocalMessage(`**Undo successful.** ${result.message}`)
            } else {
              opts.appendLocalMessage(`**Undo failed:** ${result.message}`)
            }
          } catch (err) {
            opts.appendLocalMessage(
              `**Undo failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        },

        '/rewind': () => opts.setShowRewindDialog(true),

        '/recap': async () => {
          opts.onClearAttachments()
          await opts.sendMessage(
            'Give me a brief recap of this conversation: what was the goal, what we discussed, what was built or changed, key decisions made, and where we left off. Be concise — bullet points preferred.'
          )
        },

        '/council': async () => {
          // Find the last plan content in the conversation
          const { useCouncilStore } = await import('@renderer/store/council.store')
          const { useWorkspaceStore } = await import('@renderer/store')
          const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
          if (!workspaceId) {
            opts.appendLocalMessage('**Council failed:** No active workspace.')
            return
          }

          // Use the user's text after /council as the question, or fall back
          const userQuestion = trimmed.replace(/^\/council\s*/i, '').trim()
          const inputContent = userQuestion || 'Review the current plan or last discussion.'

          useCouncilStore.getState().startCouncil(workspaceId, inputContent, inputContent)

          try {
            await window.api.councilStart({
              workspaceId,
              inputType: userQuestion ? 'question' : 'plan',
              planContent: inputContent,
              originalUserRequest: inputContent
            })
            opts.appendLocalMessage('**🏛️ LLM Council convened.** 5 advisors are now reviewing your input…')
          } catch (err) {
            opts.appendLocalMessage(
              `**Council failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        },

        '/help': () => {
          const helpLines = SLASH_COMMANDS.filter(
            (c) => !c.providers || c.providers.includes(opts.currentProvider)
          ).map(
            (c) =>
              `**\`${c.command}\`** — ${HELP_DESCRIPTIONS[c.command] ?? c.description}`
          )
          opts.appendLocalMessage(`### Available Commands\n\n${helpLines.join('\n')}`)
        }
      }

      const handler = handlers[cmd]
      if (!handler) return false

      await handler()
      return true
    },
    [opts]
  )

  return {
    executeCommand,
    filteredCommands,
    showCommands,
    selectedCommandIndex,
    setSelectedCommandIndex,
    SLASH_COMMANDS
  }
}

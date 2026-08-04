/**
 * useSlashCommands — Slash command registry, filtering, and execution.
 *
 * Extracted from MessageInput to reduce its complexity (~180 LOC).
 * Converts the original 12-branch if-chain into a data-driven command registry.
 */

import { useState, useMemo, useCallback } from 'react'
import {
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
  ScrollText,
  SearchCheck
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
  setSelectedCommandIndex: (value: number | ((prev: number) => number)) => void
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
    description: 'Grill an idea — AI-led Q&A across 8 specialist tracks',
    icon: Flame,
    iconColor: 'text-grill'
  },
  {
    command: '/effort',
    description: 'Set thinking depth (low / medium / high / xhigh / max)',
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
    command: '/audit',
    description: 'Audit the current implementation for bugs, dead code, and missed tests',
    icon: SearchCheck,
    iconColor: 'text-emerald-400'
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
  '/effort': 'Set thinking depth — `/effort low` | `/effort medium` | `/effort high` | `/effort xhigh` | `/effort max`',
  '/todos': 'Show/hide agent task list',
  '/grillme': 'Grill an idea — AI-led Q&A across 8 specialist tracks',
  '/voice': 'Toggle push-to-talk voice input',
  '/undo': 'Undo last build changes — reverts files to the previous checkpoint',
  '/rewind': 'Rewind to a previous checkpoint — reverts code AND removes messages after that point',
  '/recap': 'Get a summary of what was done in this conversation',
  '/council': 'Run the LLM Council — 5 independent AI advisors review and cross-examine your plan',
  '/audit': 'Post-implementation audit — checks wiring, bugs, tests, complexity, dead code, and runs a premortem',
  '/help': 'Show available commands'
}

// ── Audit prompts ──

/**
 * Full audit prompt — verbose with detailed instructions for each check.
 * Used for local LLMs that need explicit step-by-step guidance.
 */
const AUDIT_PROMPT = `You are performing a **post-implementation audit** of the code we built in this conversation. Systematically verify quality before this work is considered done.

## Step 0 — Scope
Before running any checks:
1. List all files you created, modified, or deleted in this conversation
2. Run \`git diff --name-only\` to cross-check against uncommitted changes
3. Use the UNION as your audit scope — but if git diff shows files NOT discussed in this conversation, note them as "out-of-scope modifications" and do NOT audit them
4. Print the final file list as a header so the user can verify

---

Perform these 6 checks IN ORDER on the scoped files.

### Check 1 — Wiring & Integration
Verify everything is properly connected — no dangling exports, missing imports, or unregistered components.
- Run **wiring_check** with all changed file paths + key new symbol names in a single call — verifies exports have importers and new symbols are referenced
- Check: new IPC handlers registered? New routes mounted? New components rendered? New test files imported in the test runner?

### Check 2 — Bug & Anti-Pattern Detection
Combine tool-based scanning with reasoning:

**Automated scans** (run these first):
- Run **eslint_check** on changed files — report any errors or warnings
- Grep for \`as any\`, \`// TODO\`, \`// HACK\`, \`// FIXME\`, empty catch blocks (\`catch {}\` or \`catch (e) {}\` with no body)

**Then reason about:**
- **Edge cases:** empty arrays, null/undefined, zero-length strings, boundary values
- **Error handling:** uncaught exceptions, swallowed errors, missing error messages
- **Race conditions:** async interleaving, shared mutable state
- **Type safety:** \`as\` casts, \`any\` types, unchecked type narrowing
- **Off-by-one:** array indexing, pagination, loop boundaries
- **State consistency:** stale closures, partial updates, missing cleanup

### Check 3 — Test Coverage
Use tools + reasoning to evaluate test adequacy:
- Run **analyze_test_coverage** — identify which changed files lack corresponding test files
- Check if new test files are registered in the test runner (e.g. run-tests.ts imports)
- Are critical paths tested (happy path + main error paths)?
- Are edge cases covered (empty inputs, nulls, boundary values)?
- Are assertions meaningful (not just "it doesn't throw")?
- List what IS tested, what IS NOT, and what SHOULD be added (with specific test case suggestions)

### Check 4 — Cyclomatic Complexity
- Run **analyze_complexity** scoped to each changed file with threshold 5
- Flag any function with complexity > 10 as high
- Note functions at 7–10 as "approaching threshold"
- For high-complexity functions, suggest specific extraction or simplification strategies

### Check 5 — Dead Code & Tech Debt
- Run **find_dead_code** scoped to changed files — identify unreferenced functions, types, constants
- Run **audit_scan** — check for TODO/FIXME/HACK markers, dead code, and complexity issues introduced by this implementation
- Check for commented-out code blocks
- Check for unused imports added by the implementation

### Check 6 — Premortem: 1 Year From Now 🔮
Position yourself 1 year in the future. This implementation has caused production incidents. For each failure scenario, state the failure AND a concrete prevention step:
- **Scaling:** What breaks at 10x/100x volume? → Prevention?
- **Maintenance:** What will confuse the next developer? → What doc/comment would prevent it?
- **Silent corruption:** Where could bad data accumulate? → What validation or monitoring catches it?
- **Security:** What attack vectors exist? → What guardrail closes them?
- **Assumptions:** What implicit assumptions could become false? → How to make them explicit?

---

## Tool Guidance
- If a tool returns an error, do NOT retry — note the error and move on
- If a tool returns zero results, that's a valid finding (report as ✅)
- Prefer **audit_scan** over individual eslint_check + analyze_complexity + find_dead_code calls
- Scale maxResults by scope: 1–3 files → maxResults: 10, 4–10 files → maxResults: 20, 10+ files → maxResults: 30
- Do NOT call find_dead_code, analyze_complexity, or eslint_check individually if you already called audit_scan — it covers all three
- When calling find_dead_code, find_callers, find_callees, or find_references, pass format: 'markdown' for compact table output
- When calling graph_map, pass tokenLimit: 4000 — audit needs less repo context than full exploration
- Keep narration minimal between tool calls — state only the check number and what you're looking for, not full reasoning

## Output Format

Use EXACTLY this structure:

## 🔍 Implementation Audit

**Scope:** [list of files being audited]

### 1. Wiring & Integration [✅|⚠️|❌]
[findings]

### 2. Bug & Anti-Pattern Detection [✅|⚠️|❌]
[findings with file paths and line numbers, severity: Critical/Major/Minor for each]

### 3. Test Coverage [✅|⚠️|❌]
[what's tested, what's missing, specific test cases to add]

### 4. Cyclomatic Complexity [✅|⚠️|❌]
[table of functions with scores, refactoring suggestions for any above threshold]

### 5. Dead Code & Tech Debt [✅|⚠️|❌]
[unreferenced symbols with file paths, TODO/FIXME markers found]

### 6. Premortem — 1 Year From Now 🔮
[failure scenario → prevention for each category]

### Summary
| Severity | Count | Key Items |
|----------|-------|-----------|
| 🔴 Critical | N | [items] |
| 🟡 Major | N | [items] |
| 🔵 Minor | N | [items] |

**Top 3 action items (by severity):**
1. ...
2. ...
3. ...`

/**
 * Lean audit prompt — compressed for Claude models that handle terse instructions well.
 * ~1,000 tokens vs ~1,800 in the full variant. Saves ~800 tokens per audit.
 */
const AUDIT_PROMPT_LEAN = `You are performing a **post-implementation audit** of the code we built in this conversation.

## Scope
List files from conversation + \`git diff --name-only\`. Print scope. Exclude out-of-scope files.

## Checks (in order)
1. **Wiring** — Run wiring_check with all changed file paths + key new symbol names in a single call. Verify exports have importers, new symbols are called, IPC/routes/tests registered.
2. **Bugs** — Run audit_scan on changed files (combines eslint_check + analyze_complexity + find_dead_code). Grep for \`as any\`, TODO, HACK, empty catches. Reason about edge cases, error handling, races, type safety, off-by-one, stale state.
3. **Tests** — Run analyze_test_coverage. Check test runner registration. Evaluate happy path + error path + edge case coverage.
4. **Complexity** — Check audit_scan results for functions above threshold. Flag >10 as high, 7–10 as approaching.
5. **Dead Code** — Check audit_scan results. Grep for TODO, HACK, FIXME. Check commented-out code, unused imports.
6. **Premortem 🔮** — For each: scaling, maintenance, silent corruption, security, assumptions → state failure + prevention.

## Tool Guidance
- If a tool returns an error, do NOT retry — note the error and move on
- If a tool returns zero results, that's a valid finding (report as ✅)
- Prefer **audit_scan** over individual eslint_check + analyze_complexity + find_dead_code calls
- Scale maxResults by scope: 1–3 files → maxResults: 10, 4–10 files → maxResults: 20, 10+ files → maxResults: 30
- Do NOT call find_dead_code, analyze_complexity, or eslint_check individually if you already called audit_scan — it covers all three
- When calling find_dead_code, find_callers, find_callees, or find_references, pass format: 'markdown' for compact table output
- When calling graph_map, pass tokenLimit: 4000 — audit needs less repo context than full exploration
- Keep narration minimal between tool calls — state only the check number and what you're looking for, not full reasoning

## Output
Use: \`## 🔍 Implementation Audit\` header, **Scope** list, then checks 1–6 with [✅|⚠️|❌] markers. End with severity table (🔴Critical/🟡Major/🔵Minor counts) and top 3 action items.`

/** Select audit prompt based on provider — lean for Claude, full for local LLMs */
function getAuditPrompt(provider: LLMProvider): string {
  return provider === 'claude' ? AUDIT_PROMPT_LEAN : AUDIT_PROMPT
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
          const validEfforts: ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
          if (arg && validEfforts.includes(arg as ThinkingEffort)) {
            const effort = arg as ThinkingEffort
            await window.api.updateEffort({
              conversationId: opts.currentConversationId,
              effort
            })
            opts.setEffort(opts.currentConversationId, effort)
            opts.appendLocalMessage(`Thinking effort set to **${effort}**`)
          } else {
            opts.appendLocalMessage('Usage: `/effort low` | `/effort medium` | `/effort high` | `/effort xhigh` | `/effort max`')
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

          const councilState = useCouncilStore.getState()
          councilState.startCouncil()

          try {
            const { sessionId } = await window.api.councilStart({
              workspaceId,
              inputType: userQuestion ? 'question' : 'plan',
              planContent: inputContent,
              originalUserRequest: inputContent
            })
            councilState.setSessionIdentity(sessionId, workspaceId)
            opts.appendLocalMessage(
              '**🏛️ LLM Council convened.** 5 advisors are now reviewing your input…'
            )
          } catch (err) {
            opts.appendLocalMessage(
              `**Council failed:** ${err instanceof Error ? err.message : String(err)}`
            )
          }
        },

        '/audit': async () => {
          opts.onClearAttachments()
          await opts.sendMessage(getAuditPrompt(opts.currentProvider))
        },

        '/help': () => {
          const helpLines = SLASH_COMMANDS.filter(
            (c) => !c.providers || c.providers.includes(opts.currentProvider)
          ).map((c) => `**\`${c.command}\`** — ${HELP_DESCRIPTIONS[c.command] ?? c.description}`)
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

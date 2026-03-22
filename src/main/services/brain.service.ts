import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dbLogger } from '../logger'
import { messageRepository, conversationRepository } from '../db/repositories'
import type { BrainEntry } from '../../shared/types'

const log = dbLogger

/** Maximum lines per brain file before compaction triggers */
const MAX_LINES = 500
/** Lines to keep after compaction */
const COMPACT_KEEP_LINES = 300
/** Maximum messages to read when summarizing a conversation */
const SUMMARY_MAX_MESSAGES = 30

const PROJECT_STATE_TEMPLATE = `# Project State
> Auto-maintained by Agent Studio. Last updated: {timestamp}

## Current Phase
_Not yet set_

## Completed Items
_None yet_

## Pending Items
_None yet_

## Active Conversations
_None_
`

const CHANGELOG_TEMPLATE = `# Changelog
> Auto-maintained by Agent Studio. Newest entries first.

---
`

const DECISIONS_TEMPLATE = `# Decisions Log
> Auto-maintained by Agent Studio. Key decisions and rationale.

---
`

const ERRORS_TEMPLATE = `# Errors & Resolutions
> Auto-maintained by Agent Studio. Errors encountered and how they were resolved.

---
`

class BrainService {
  private brainDir(workspacePath: string): string {
    return join(workspacePath, '.brain')
  }

  /** Initialize .brain/ directory with template files if missing */
  initialize(workspacePath: string): void {
    const dir = this.brainDir(workspacePath)

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      log.info('Created .brain/ directory:', dir)
    }

    const timestamp = new Date().toISOString()

    const files: Array<{ name: string; template: string }> = [
      { name: 'project-state.md', template: PROJECT_STATE_TEMPLATE.replace('{timestamp}', timestamp) },
      { name: 'changelog.md', template: CHANGELOG_TEMPLATE },
      { name: 'decisions-log.md', template: DECISIONS_TEMPLATE },
      { name: 'errors-resolutions.md', template: ERRORS_TEMPLATE }
    ]

    for (const file of files) {
      const filePath = join(dir, file.name)
      if (!existsSync(filePath)) {
        writeFileSync(filePath, file.template, 'utf-8')
        log.info('Created brain file:', filePath)
      }
    }
  }

  /** Append a completed-work entry to changelog.md */
  logCompletion(workspacePath: string, entry: BrainEntry): void {
    const filePath = join(this.brainDir(workspacePath), 'changelog.md')
    if (!existsSync(filePath)) {
      this.initialize(workspacePath)
    }

    const block = this.formatEntry(entry)
    appendFileSync(filePath, block, 'utf-8')
    this.compactIfNeeded(filePath, MAX_LINES)
  }

  /** Append a decision entry to decisions-log.md */
  logDecision(workspacePath: string, entry: BrainEntry): void {
    const filePath = join(this.brainDir(workspacePath), 'decisions-log.md')
    if (!existsSync(filePath)) {
      this.initialize(workspacePath)
    }

    const block = this.formatEntry(entry)
    appendFileSync(filePath, block, 'utf-8')
    this.compactIfNeeded(filePath, MAX_LINES)
  }

  /** Append an error+resolution to errors-resolutions.md */
  logError(workspacePath: string, entry: BrainEntry): void {
    const filePath = join(this.brainDir(workspacePath), 'errors-resolutions.md')
    if (!existsSync(filePath)) {
      this.initialize(workspacePath)
    }

    const block = this.formatEntry(entry)
    appendFileSync(filePath, block, 'utf-8')
    this.compactIfNeeded(filePath, MAX_LINES)
  }

  /** Update project-state.md with current status snapshot */
  updateProjectState(
    workspacePath: string,
    state: { completed: string[]; pending: string[]; activePhase: string }
  ): void {
    const filePath = join(this.brainDir(workspacePath), 'project-state.md')
    if (!existsSync(filePath)) {
      this.initialize(workspacePath)
    }

    const timestamp = new Date().toISOString()
    const completedList =
      state.completed.length > 0
        ? state.completed.map((item) => `- ${item}`).join('\n')
        : '_None yet_'
    const pendingList =
      state.pending.length > 0
        ? state.pending.map((item) => `- ${item}`).join('\n')
        : '_None yet_'

    const content = `# Project State
> Auto-maintained by Agent Studio. Last updated: ${timestamp}

## Current Phase
${state.activePhase || '_Not yet set_'}

## Completed Items
${completedList}

## Pending Items
${pendingList}
`

    writeFileSync(filePath, content, 'utf-8')
  }

  /** Read project-state.md content */
  getProjectState(workspacePath: string): string {
    const filePath = join(this.brainDir(workspacePath), 'project-state.md')
    if (!existsSync(filePath)) {
      return ''
    }
    return readFileSync(filePath, 'utf-8')
  }

  /** Read all brain context as a single string (for injection into prompts) */
  getContext(workspacePath: string): string {
    const dir = this.brainDir(workspacePath)
    if (!existsSync(dir)) {
      return ''
    }

    const sections: string[] = []
    const files = [
      'project-state.md',
      'changelog.md',
      'decisions-log.md',
      'errors-resolutions.md'
    ]

    for (const fileName of files) {
      const filePath = join(dir, fileName)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8').trim()
          // Skip files that only contain the template header
          if (content && !this.isOnlyTemplate(content)) {
            sections.push(content)
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    return sections.length > 0 ? sections.join('\n\n---\n\n') : ''
  }

  /** Build a conversation summary from messages in DB */
  summarizeConversation(conversationId: string): string {
    try {
      const conversation = conversationRepository.findById(conversationId)
      const title = conversation?.title || 'Untitled conversation'

      const messages = messageRepository.findByConversation(conversationId)
      if (messages.length === 0) {
        return `Conversation "${title}" — no messages`
      }

      // Take the last N messages for summary
      const recent = messages.slice(-SUMMARY_MAX_MESSAGES)

      // Extract key actions: user requests and assistant responses (first line only)
      const summaryLines: string[] = []
      for (const msg of recent) {
        const firstLine = msg.content.split('\n')[0].substring(0, 200)
        if (msg.role === 'user') {
          summaryLines.push(`  - User: ${firstLine}`)
        } else if (msg.role === 'assistant' || msg.role === 'coordinator') {
          summaryLines.push(`  - Agent: ${firstLine}`)
        }
      }

      // Cap summary to avoid bloat
      const capped = summaryLines.slice(-10)
      return `Conversation "${title}" (${messages.length} messages):\n${capped.join('\n')}`
    } catch (error) {
      log.warn('Failed to summarize conversation:', error)
      return `Conversation ${conversationId} — summary unavailable`
    }
  }

  /** Format a BrainEntry into a markdown block */
  private formatEntry(entry: BrainEntry): string {
    const lines = [
      '',
      `### [${entry.type.toUpperCase()}] ${entry.conversationTitle}`,
      `> ${entry.timestamp}`,
      '',
      entry.summary
    ]

    if (entry.details) {
      lines.push('', '**Details:**', entry.details)
    }

    lines.push('', '---', '')
    return lines.join('\n')
  }

  /** Check if file content is only the default template (no real entries) */
  private isOnlyTemplate(content: string): boolean {
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    // Templates have <=6 non-empty lines and contain "Auto-maintained" + "_None" or "---" only
    if (lines.length <= 6) {
      const hasAutoMaintained = lines.some((l) => l.includes('Auto-maintained'))
      const hasOnlyPlaceholders = lines.every(
        (l) =>
          l.startsWith('#') ||
          l.startsWith('>') ||
          l.startsWith('---') ||
          l.startsWith('_')
      )
      return hasAutoMaintained && hasOnlyPlaceholders
    }
    return false
  }

  /** Compact a brain file if it exceeds line threshold */
  private compactIfNeeded(filePath: string, maxLines: number): void {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      if (lines.length <= maxLines) {
        return
      }

      log.info(`Compacting brain file ${filePath}: ${lines.length} lines -> ~${COMPACT_KEEP_LINES} lines`)

      // Keep the header (first 4 lines) and the most recent entries
      const headerLines = lines.slice(0, 4)
      const recentLines = lines.slice(-COMPACT_KEEP_LINES)

      const compacted = [
        ...headerLines,
        '',
        `> _Compacted on ${new Date().toISOString()} — older entries removed to keep file size manageable_`,
        '',
        '---',
        '',
        ...recentLines
      ].join('\n')

      writeFileSync(filePath, compacted, 'utf-8')
    } catch (error) {
      log.warn('Brain file compaction failed:', error)
    }
  }
}

export const brainService = new BrainService()

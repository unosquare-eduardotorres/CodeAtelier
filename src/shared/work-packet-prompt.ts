/**
 * Render a work packet into the text a builder actually reads.
 *
 * The packet exists so a weak builder never explores: everything it needs is
 * pasted in, and everything it may touch is named. The wording here is
 * deliberately imperative and repetitive about the write-set and the tests,
 * because those are the two constraints a small model most reliably forgets —
 * and both are machine-checked afterwards, so forgetting costs a retry.
 */

import type { BlueprintWorkPacket } from './blueprint-types'

/** Excerpts are the bulkiest part of a packet; cap what reaches the prompt. */
const MAX_EXCERPT_CHARS = 4000
const MAX_TOTAL_EXCERPT_CHARS = 20_000

export interface RenderPacketOptions {
  /**
   * Local/small-context models get the strictest phrasing. Larger models are
   * given the same constraints without the emphasis, which otherwise crowds out
   * the actual task.
   */
  strict?: boolean
}

export function renderWorkPacket(
  packet: BlueprintWorkPacket | null | undefined,
  options: RenderPacketOptions = {}
): string {
  if (!packet) return ''
  const lines: string[] = []

  lines.push('## Work Packet')
  lines.push('')
  lines.push(
    options.strict
      ? 'Everything you need is below. **Do not explore the codebase** — do not search, do not list directories, do not read files that are not named here. Exploring wastes the context this packet was built to save.'
      : 'Everything needed for this task is below. Prefer it over exploring the codebase.'
  )

  if (packet.interfaces?.length) {
    lines.push('')
    lines.push('### Implement against these signatures')
    lines.push('')
    for (const sig of packet.interfaces) {
      lines.push('```')
      lines.push(sig)
      lines.push('```')
    }
  }

  if (packet.contextExcerpts?.length) {
    lines.push('')
    lines.push('### Context (pre-read for you)')
    let budget = MAX_TOTAL_EXCERPT_CHARS
    for (const excerpt of packet.contextExcerpts) {
      if (budget <= 0) break
      const body = excerpt.excerpt.slice(0, Math.min(MAX_EXCERPT_CHARS, budget))
      budget -= body.length
      lines.push('')
      lines.push(`**${excerpt.path}**${excerpt.note ? ` — ${excerpt.note}` : ''}`)
      lines.push('```')
      lines.push(body)
      lines.push('```')
    }
  }

  if (packet.acceptanceCriteria?.length) {
    lines.push('')
    lines.push('### Acceptance criteria')
    lines.push('')
    lines.push('The task is done when every one of these holds. Each names how it is checked.')
    lines.push('')
    for (const [i, ac] of packet.acceptanceCriteria.entries()) {
      lines.push(`${i + 1}. ${ac.text}`)
      lines.push(`   - **Verified by:** ${ac.howVerified}`)
    }
  }

  if (packet.allowedFiles?.length) {
    lines.push('')
    lines.push('### Write-set — the ONLY files you may change')
    lines.push('')
    for (const file of packet.allowedFiles) lines.push(`- \`${file}\``)
    lines.push('')
    lines.push(
      'Changes to any other file are rejected automatically and the task is sent back to you. ' +
        'If the task genuinely cannot be completed within this set, say so in your completion block instead of editing outside it.'
    )
  }

  if (packet.forbiddenFiles?.length) {
    lines.push('')
    lines.push('### Never touch')
    lines.push('')
    for (const file of packet.forbiddenFiles) lines.push(`- \`${file}\``)
  }

  if (packet.testFiles?.length) {
    lines.push('')
    lines.push('### Tests — these are the specification')
    lines.push('')
    for (const file of packet.testFiles) lines.push(`- \`${file}\``)
    lines.push('')
    lines.push(
      'These tests exist and currently **fail**. Your job is to make them pass by writing the implementation. ' +
        '**Do not edit, delete, skip or weaken them** — the files are hashed before and after, and any change fails the task.'
    )
    if (packet.testCommand) {
      lines.push('')
      lines.push(`Run them with: \`${packet.testCommand}\``)
      // P2 — keep R1.1's parse-time drop exceptional: the packet author is
      // told up front what a valid command looks like, so a value being
      // dropped at parse time means the author ignored this line, not that
      // the contract was unknowable.
      lines.push(
        'The command must be a plain command with no shell metacharacters ' +
          '(`; | & > < $ ( ) { }`) — values containing them are dropped and the gate reports `no_command`.'
      )
    }
  }

  if (packet.conventions?.length) {
    lines.push('')
    lines.push('### Conventions that apply here')
    lines.push('')
    for (const rule of packet.conventions) lines.push(`- ${rule}`)
  }

  return lines.join('\n')
}

/** True when the packet carries enough for the gates to mean anything. */
export function isPacketActionable(packet: BlueprintWorkPacket | null | undefined): boolean {
  if (!packet) return false
  return Boolean(
    packet.allowedFiles?.length || packet.testFiles?.length || packet.acceptanceCriteria?.length
  )
}

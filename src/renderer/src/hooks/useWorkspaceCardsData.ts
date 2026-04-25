import { useEffect, useState } from 'react'
import type { Workspace, Conversation } from '../../../shared/types'
import type { WorkspaceCardData } from '@renderer/components/welcome/WorkspaceCard'

const PLACEHOLDERS = [
  'A workspace ready for exploration — open it to discover what lives inside.',
  'Untitled project. Add a CLAUDE.md or README.md to give it a story.',
  'No description yet. The atelier awaits its first brushstroke.',
  'Quiet for now. Drop in some notes and watch the canvas fill.',
  'Fresh canvas, freshly chiseled — pick up the chisel and begin.'
] as const

/** Stable hash of a string → 32-bit unsigned int. */
function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i)
    h |= 0 // force int32
  }
  return Math.abs(h)
}

function pickPlaceholder(seed: string): string {
  return PLACEHOLDERS[hashSeed(seed) % PLACEHOLDERS.length]
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // Trim back to the last word boundary before max-1 to keep the ellipsis clean
  const sliced = text.slice(0, max - 1)
  const lastSpace = sliced.lastIndexOf(' ')
  const cut = lastSpace > Math.floor(max * 0.6) ? sliced.slice(0, lastSpace) : sliced
  return `${cut.trimEnd()}…`
}

/**
 * Strip markdown formatting that hurts readability in a one-liner card description.
 * - Replaces `[text](url)` with just `text`
 * - Removes leading `> ` block quotes
 * - Strips inline `code`, **bold**, *italic*, `~~strike~~` markers
 * - Collapses whitespace
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/^\s*>\s?/gm, '') // block quotes
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/<[^>]+>/g, '') // raw HTML tags
    .replace(/\s+/g, ' ')
    .trim()
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+/.test(line)
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
}

function isBadgeOrImage(line: string): boolean {
  // [![alt](img)](href)  or  ![alt](img)  or pure HTML badge
  return (
    /^\s*\[?!\[/.test(line) || /^\s*<img\b/i.test(line) || /^\s*<a\b[^>]*>\s*<img\b/i.test(line)
  )
}

function isHtmlOnly(line: string): boolean {
  return /^\s*<[^>]+>\s*$/.test(line)
}

/**
 * Extract the first plain-prose paragraph from a markdown document.
 *
 * If `preferOverview` is true (CLAUDE.md), prefer the paragraph that follows the
 * first `## Overview` heading. Otherwise / for README, skip leading badges, HTML,
 * headings, and horizontal rules and return the first prose paragraph.
 */
function extractFirstParagraph(content: string, preferOverview: boolean): string | null {
  const lines = content.split(/\r?\n/)

  let startIdx = 0
  if (preferOverview) {
    const overviewIdx = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+overview\b/i.test(l))
    if (overviewIdx >= 0) startIdx = overviewIdx + 1
  }

  // Walk forward, accumulating a paragraph (consecutive non-empty lines).
  let buffer: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      if (buffer.length > 0) {
        const para = buffer.join(' ').trim()
        const cleaned = stripMarkdown(para)
        if (cleaned.length >= 20) return cleaned
        buffer = []
      }
      continue
    }

    // Skip lines that aren't prose
    if (
      isHeading(trimmed) ||
      isHorizontalRule(trimmed) ||
      isBadgeOrImage(trimmed) ||
      isHtmlOnly(trimmed)
    ) {
      // Flush any pending buffer first (in case prose came before this skippable line)
      if (buffer.length > 0) {
        const para = buffer.join(' ').trim()
        const cleaned = stripMarkdown(para)
        if (cleaned.length >= 20) return cleaned
        buffer = []
      }
      continue
    }

    buffer.push(trimmed)
  }

  if (buffer.length > 0) {
    const para = buffer.join(' ').trim()
    const cleaned = stripMarkdown(para)
    if (cleaned.length >= 20) return cleaned
  }
  return null
}

async function resolveDescription(repoPath: string, name: string): Promise<string> {
  // 1) CLAUDE.md → "## Overview" first, else first prose paragraph
  // 2) README.md → first prose paragraph
  // 3) creative placeholder seeded by workspace name
  for (const file of ['CLAUDE.md', 'README.md'] as const) {
    try {
      const content = await window.api.readWorkspaceFile({
        filePath: `${repoPath}/${file}`
      })
      if (typeof content === 'string' && content.length > 0) {
        const para = extractFirstParagraph(content, file === 'CLAUDE.md')
        if (para) return truncate(para, 160)
      }
    } catch {
      // file missing or unreadable — fall through to next source
    }
  }
  return pickPlaceholder(name)
}

async function loadOne(ws: Workspace): Promise<WorkspaceCardData> {
  const [convos, settings, github, specialist, description] = await Promise.all([
    window.api.getConversations({ workspaceId: ws.id }).catch(() => [] as Conversation[]),
    window.api
      .getWorkspaceSettings({ workspaceId: ws.id })
      .catch(() => ({}) as Record<string, unknown>),
    window.api
      .getGitHubStatus({ workspaceId: ws.id })
      .catch(() => ({ configured: false }) as { configured: boolean; login?: string }),
    window.api.getProjectSpecialist({ workspaceId: ws.id }).catch(() => null) as Promise<{
      buildStatus?: string
    } | null>,
    resolveDescription(ws.repoPath, ws.name)
  ])

  return {
    description,
    chatCounts: {
      active: convos.filter((c) => c.status === 'active').length,
      total: convos.length
    },
    capabilities: {
      githubRepo: !!github?.configured,
      codeGraph: settings.repomapEnabled === true,
      semanticSearch: settings.semanticSearchEnabled === true,
      specialist: specialist?.buildStatus === 'ready'
    }
  }
}

/**
 * Lazy-loads per-workspace card data in parallel. Re-runs when the workspace
 * id-set changes; previously-loaded entries are preserved across re-renders.
 */
export function useWorkspaceCardsData(
  workspaces: Workspace[]
): Record<string, WorkspaceCardData | undefined> {
  const [data, setData] = useState<Record<string, WorkspaceCardData>>({})

  // Stable key — only refetch when the set of workspace ids changes.
  const idsKey = workspaces.map((w) => w.id).join(',')

  useEffect(() => {
    let cancelled = false
    workspaces.forEach((ws) => {
      // Skip workspaces we've already fetched in this hook instance.
      if (data[ws.id]) return
      loadOne(ws)
        .then((d) => {
          if (!cancelled) setData((prev) => ({ ...prev, [ws.id]: d }))
        })
        .catch(() => {
          // Swallow — keep card in skeleton state rather than crash the welcome screen.
        })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  return data
}

// Exported for unit testing if needed; not part of the public hook surface.
export const __test = { extractFirstParagraph, stripMarkdown, truncate, pickPlaceholder }

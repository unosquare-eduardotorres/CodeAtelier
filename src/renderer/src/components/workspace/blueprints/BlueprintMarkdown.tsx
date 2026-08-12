/**
 * BlueprintMarkdown — shared markdown renderer with the standard
 * prose-invert class stack. Used by description blocks, spec, review,
 * verify, and any other phase content that renders markdown.
 *
 * Deduplicates the prose class strings previously scattered across
 * PhaseListItem and BlueprintDescriptionBlock.
 */

import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

const PROSE_CLASSES = `prose prose-sm prose-invert max-w-none text-text-secondary
  prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
  prose-p:text-sm prose-p:my-1.5
  prose-li:text-sm prose-ul:my-1 prose-ol:my-1
  prose-code:text-xs prose-code:bg-surface-inset prose-code:px-1 prose-code:rounded
  prose-code:before:content-none prose-code:after:content-none
  prose-pre:bg-surface-base prose-pre:border prose-pre:border-border-subtle prose-pre:rounded-lg prose-pre:my-1.5
  prose-strong:text-text-primary`

interface BlueprintMarkdownProps {
  children: string
  className?: string
}

export function BlueprintMarkdown({ children, className }: BlueprintMarkdownProps): JSX.Element {
  return (
    <div className={`${PROSE_CLASSES} ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown>
    </div>
  )
}

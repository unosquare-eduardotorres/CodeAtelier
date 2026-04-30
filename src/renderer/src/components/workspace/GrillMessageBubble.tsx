/**
 * GrillMessageBubble — chat-like message bubble for grill streaming.
 *
 * Shows da-vinci avatar, streaming markdown text, and tool activities.
 * Modeled after AuditMessageBubble but uses the da-vinci avatar and accent border.
 */

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import { Avatar } from '@renderer/components/common'
import { CodeBlock } from '../chat/CodeBlock'
import ToolActivityBlock from '../chat/ToolActivityBlock'
import type { ToolActivity } from '../../../../shared/types'

interface GrillMessageBubbleProps {
  content: string
  toolActivities: ToolActivity[]
  isStreaming: boolean
}

/** Strip stray backticks from markdown content — prevents rendering artefacts */
function stripStrayBackticks(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      const stripped = child.replace(/`/g, '')
      return stripped || null
    }
    if (React.isValidElement(child) && (child.props as Record<string, unknown>)?.children) {
      const childProps = child.props as Record<string, unknown>
      return React.cloneElement(child, {
        ...childProps,
        children: stripStrayBackticks(childProps.children as React.ReactNode)
      } as Record<string, unknown>)
    }
    return child
  })
}

// Module-level markdown components — stable reference, avoids ReactMarkdown full re-render
const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p>{stripStrayBackticks(children)}</p>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{stripStrayBackticks(children)}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong>{stripStrayBackticks(children)}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{stripStrayBackticks(children)}</em>,
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-')
    if (isBlock) {
      return <code className={`${className} text-sm`}>{children}</code>
    }
    return (
      <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
    )
  }
}

export default function GrillMessageBubble({
  content,
  toolActivities,
  isStreaming
}: GrillMessageBubbleProps): React.JSX.Element {
  return (
    <div className="flex gap-3 flex-row">
      {/* Avatar — grill analyst portrait */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="grillme" size="md" />
      </div>

      <div className="flex flex-col min-w-0 max-w-[85%] items-start">
        <span className="text-sm font-semibold text-text-primary mb-1">Grill Analyst</span>

        {/* Markdown content */}
        <div className="rounded-md px-5 py-4 bg-surface-overlay text-text-body border-l-[3px] border-accent/60 shadow-sm overflow-hidden min-w-0">
          {content ? (
            <div className="prose max-w-none overflow-hidden text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : isStreaming ? (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce [animation-delay:300ms]" />
            </div>
          ) : null}
        </div>

        {/* Tool activities — reuse existing component directly */}
        {toolActivities.length > 0 && <ToolActivityBlock activities={toolActivities} />}
      </div>
    </div>
  )
}

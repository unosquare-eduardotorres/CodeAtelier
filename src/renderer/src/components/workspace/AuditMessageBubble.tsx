/**
 * AuditMessageBubble — simplified, read-only message bubble for audit streaming.
 *
 * A lightweight version of the chat MessageBubble — no user interaction,
 * no plan cards, no grill. Renders streaming markdown text and tool activities.
 */

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import { Avatar } from '@renderer/components/common'
import { useChatBubbleSize } from '@renderer/store'
import { CodeBlock } from '../chat/CodeBlock'
import ToolActivityBlock from '../chat/ToolActivityBlock'
import type { ToolActivity } from '../../../../shared/types'
import type { ChatBubbleSize } from '../../../../shared/types'

const BUBBLE_SIZE_CLASSES: Record<ChatBubbleSize, { text: string; maxWidth: string }> = {
  small: { text: 'text-xs leading-relaxed', maxWidth: 'max-w-[75%]' },
  medium: { text: 'text-sm leading-relaxed', maxWidth: 'max-w-[80%]' },
  large: { text: 'text-[15px] leading-relaxed', maxWidth: 'max-w-[85%]' },
  xl: { text: 'text-base leading-relaxed', maxWidth: 'max-w-[85%]' }
}

interface AuditMessageBubbleProps {
  content: string
  toolActivities: ToolActivity[]
  trackName: string
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

export default function AuditMessageBubble({
  content,
  toolActivities,
  trackName,
  isStreaming
}: AuditMessageBubbleProps): React.JSX.Element {
  const bubbleSize = useChatBubbleSize()
  const sizeClasses = BUBBLE_SIZE_CLASSES[bubbleSize]

  return (
    <div className="flex gap-3 flex-row">
      {/* Avatar — branded auditor portrait */}
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="atelier-auditor" size="sm" />
      </div>

      <div className={`flex flex-col min-w-0 ${sizeClasses.maxWidth} items-start`}>
        <span className="text-sm font-semibold text-text-primary mb-1">{trackName} Auditor</span>

        {/* Markdown content */}
        <div className="rounded-md px-5 py-4 bg-surface-overlay text-text-body border-l-[3px] border-primary/60 shadow-sm overflow-hidden min-w-0">
          {content ? (
            <div className={`prose max-w-none overflow-hidden ${sizeClasses.text}`}>
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

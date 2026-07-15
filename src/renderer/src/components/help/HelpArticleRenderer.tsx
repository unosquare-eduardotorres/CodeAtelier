import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { MermaidDiagram } from '@renderer/components/common'

/**
 * HelpArticleRenderer — Renders markdown help content as rich, readable documentation.
 *
 * Uses ReactMarkdown with the same plugin stack as MessageBubble (remark-gfm, remark-breaks)
 * but with a wider prose container optimized for long-form reading, not chat bubbles.
 *
 * Accessibility:
 * - Sequential heading hierarchy enforced by content authoring
 * - All images require alt text (rendered from markdown ![alt](src))
 * - Keyboard-navigable links with visible focus states
 * - Semantic HTML output compatible with screen readers
 */

interface HelpArticleRendererProps {
  /** Raw markdown content to render */
  content: string
  /** Optional CSS class overrides */
  className?: string
}

/** Custom components for ReactMarkdown — optimized for documentation reading */
const markdownComponents = {
  // Headings with anchor IDs for deep-linking
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
    const id = getHeadingId(children)
    return (
      <h1
        id={id}
        className="text-3xl font-bold text-text-primary mt-8 mb-4 first:mt-0 scroll-mt-6"
        {...props}
      >
        {children}
      </h1>
    )
  },
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
    const id = getHeadingId(children)
    return (
      <h2
        id={id}
        className="text-2xl font-semibold text-text-primary mt-8 mb-3 scroll-mt-6 border-b border-border-subtle pb-2"
        {...props}
      >
        {children}
      </h2>
    )
  },
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => {
    const id = getHeadingId(children)
    return (
      <h3
        id={id}
        className="text-xl font-semibold text-text-primary mt-6 mb-2 scroll-mt-6"
        {...props}
      >
        {children}
      </h3>
    )
  },
  h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="text-lg font-medium text-text-primary mt-4 mb-2" {...props}>
      {children}
    </h4>
  ),

  // Paragraphs with readable line height and width
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="text-base text-text-body leading-7 mb-4" {...props}>
      {children}
    </p>
  ),

  // Links with visible focus states and proper contrast
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      className="text-primary-text hover:text-primary-hover underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 rounded-sm transition-colors"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault()
        if (href) window.open(href, '_blank')
      }}
    >
      {children}
    </a>
  ),

  // Code blocks with mermaid diagram support
  pre: ({ children }: { children?: React.ReactNode }) => {
    // Check if this is a mermaid code block
    const child = React.Children.toArray(children)[0]
    if (React.isValidElement(child)) {
      const className = (child.props as { className?: string }).className || ''
      if (className.includes('language-mermaid')) {
        const code = String((child.props as { children?: React.ReactNode }).children || '').trim()
        return (
          <div className="my-4">
            <MermaidDiagram definition={code} />
          </div>
        )
      }
    }
    return (
      <pre className="bg-surface-raised border border-border-subtle rounded-lg p-4 overflow-x-auto my-4 text-sm">
        {children}
      </pre>
    )
  },

  // Inline code
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    if (className?.includes('language-')) {
      return <code className={`${className} text-sm leading-relaxed`}>{children}</code>
    }
    return (
      <code className="bg-surface-overlay px-1.5 py-0.5 rounded text-sm text-primary-text font-mono">
        {children}
      </code>
    )
  },

  // Tables
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto rounded-lg border border-border-default my-4">
      <table className="min-w-full divide-y divide-border-subtle">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-surface-raised">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-4 py-2.5 text-left text-sm font-semibold text-text-primary">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-2.5 text-sm text-text-body border-t border-border-subtle">{children}</td>
  ),

  // Lists
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-1.5 text-text-body">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-1.5 text-text-body">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-base leading-7 pl-1">{children}</li>
  ),

  // Blockquotes — used for tips and callouts
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-4 border-primary/40 bg-surface-overlay rounded-r-lg pl-4 pr-4 py-3 my-4 text-text-secondary italic">
      {children}
    </blockquote>
  ),

  // Horizontal rule
  hr: () => <hr className="border-border-subtle my-8" />,

  // Images with lazy loading and reserved dimensions
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <figure className="my-6">
      <img
        src={src}
        alt={alt || 'Help documentation image'}
        loading="lazy"
        className="rounded-lg border border-border-subtle max-w-full shadow-sm"
      />
      {alt && alt !== 'Help documentation image' && (
        <figcaption className="mt-2 text-sm text-text-muted text-center italic">{alt}</figcaption>
      )}
    </figure>
  ),

  // Strong and emphasis
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-primary">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-text-secondary">{children}</em>
  )
}

/** Generate a URL-safe ID from heading children */
function getHeadingId(children: React.ReactNode): string {
  const text = React.Children.toArray(children)
    .map((child) => (typeof child === 'string' ? child : ''))
    .join('')
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function HelpArticleRenderer({
  content,
  className = ''
}: HelpArticleRendererProps): React.JSX.Element {
  const plugins = useMemo(() => [remarkGfm, remarkBreaks], [])

  return (
    <article
      data-testid="help-article"
      className={`max-w-[75ch] mx-auto ${className}`}
      role="article"
      aria-label="Help documentation"
    >
      <ReactMarkdown remarkPlugins={plugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </article>
  )
}

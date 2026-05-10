/**
 * CodeBlock — renders fenced code blocks with copy button and Mermaid support.
 * Extracted from MessageBubble.tsx for maintainability.
 */
import React, { useState, useCallback } from 'react'
import { Copy, Check } from 'lucide-react'
import { MermaidDiagram } from '@renderer/components/common'

export function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // Extract language and code text from children
  const codeChild = React.Children.toArray(children).find(
    (child): child is React.ReactElement =>
      React.isValidElement(child) && (child as React.ReactElement).type === 'code'
  )

  const className = (codeChild?.props as { className?: string })?.className || ''
  const language = className.replace('language-', '')
  const codeText = String(
    (codeChild?.props as { children?: React.ReactNode })?.children || ''
  ).replace(/\n$/, '')

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      console.error('Failed to copy to clipboard')
    }
  }, [codeText])

  // Mermaid: render as interactive diagram
  if (language === 'mermaid') {
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border-subtle">
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-base border-b border-border-subtle">
          <span className="text-xs text-primary-text font-mono">mermaid diagram</span>
        </div>
        <MermaidDiagram definition={codeText} />
      </div>
    )
  }

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-border-subtle">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-raised border-b border-border-default">
        <span className="text-xs text-primary/70 font-mono tracking-wide uppercase">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-primary-text transition-colors px-1.5 py-0.5 rounded hover:bg-primary-muted"
          aria-label={copied ? 'Copied!' : 'Copy code'}
          title={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check size={12} className="text-success" />
              <span className="text-success">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="bg-surface-base p-3 overflow-x-auto text-sm whitespace-pre-wrap break-words">
        {children}
      </pre>
    </div>
  )
}

/**
 * CodeBlock — renders fenced code blocks with syntax highlighting, copy button,
 * and Mermaid support. Uses prism-react-renderer for token coloring.
 */
import React, { useState, useCallback, useMemo } from 'react'
import { Copy, Check } from 'lucide-react'
import { Highlight, themes, type PrismTheme } from 'prism-react-renderer'
import { MermaidDiagram } from '@renderer/components/common'
import { useAppTheme } from '@renderer/store'

/** Recursively extract text content from a React node tree */
function extractTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractTextContent).join('')
  if (React.isValidElement(node)) {
    const props = node.props as Record<string, unknown>
    if (typeof props.filePath === 'string') return String(props.filePath)
    if (props.children != null) return extractTextContent(props.children as React.ReactNode)
  }
  return ''
}

/** Map app theme → Prism highlight theme */
const PRISM_THEME_MAP: Record<string, PrismTheme> = {
  'code-atelier': themes.nightOwl,
  glass: themes.nightOwl,
  porcelain: themes.vsLight,
  developer: themes.vsDark
}

/** Show line numbers when a code block has more than this many lines */
const LINE_NUMBER_THRESHOLD = 5

export function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const appTheme = useAppTheme()

  // Extract language and code text from children
  const codeChild = React.Children.toArray(children).find(
    (child): child is React.ReactElement =>
      React.isValidElement(child) && (child as React.ReactElement).type === 'code'
  )

  // Extract language only from valid language-* class prefixes
  const rawClassName = (codeChild?.props as { className?: string })?.className || ''
  const langMatch = rawClassName.match(/language-(\S+)/)
  const language = langMatch ? langMatch[1] : ''

  // Extract code text: <code> child first, fallback to recursive extraction
  const rawChildren = (codeChild?.props as { children?: React.ReactNode })?.children
  const codeText = (
    rawChildren != null ? String(rawChildren) : extractTextContent(children)
  ).replace(/\n$/, '')

  const prismTheme = useMemo(() => PRISM_THEME_MAP[appTheme] ?? themes.nightOwl, [appTheme])

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
      <Highlight theme={prismTheme} code={codeText} language={language || 'text'}>
        {({ tokens, getLineProps, getTokenProps, style }) => {
          const showLineNumbers = tokens.length > LINE_NUMBER_THRESHOLD
          return (
            <pre
              className="p-3 overflow-x-auto text-sm"
              style={{ ...style, background: 'var(--color-surface-base)' }}
            >
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line })}>
                  {showLineNumbers && (
                    <span className="select-none text-text-muted w-8 inline-block text-right mr-3 text-[11px] opacity-60">
                      {i + 1}
                    </span>
                  )}
                  {line.map((token, k) => (
                    <span key={k} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </pre>
          )
        }}
      </Highlight>
    </div>
  )
}

/**
 * CodeBlock — renders fenced code blocks with syntax highlighting, copy button,
 * and Mermaid support. Uses prism-react-renderer for token coloring.
 */
import React, { useState, useCallback, useMemo } from 'react'
import { Copy, Check } from 'lucide-react'
import { Highlight, themes, type PrismTheme } from 'prism-react-renderer'
import { MermaidDiagram } from '@renderer/components/common'
import { useAppTheme } from '@renderer/store'
import { copyTextToClipboard } from '@renderer/utils/clipboard'

/** Best-effort language detection for untagged code blocks */
function detectLanguage(code: string): string {
  const trimmed = code.trimStart()

  // Mermaid — first line is a diagram type keyword
  // Note: `graph` requires a direction (TD/TB/BT/RL/LR) to avoid false positives
  if (
    /^(flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|gitgraph|journey|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta|requirementDiagram|C4Context|C4Container|C4Component|C4Deployment|zenuml)\b/.test(
      trimmed
    ) ||
    /^graph\s+(TD|TB|BT|RL|LR)\b/.test(trimmed) ||
    /^---\s*\n[\s\S]*?\n---\s*\n\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|gitgraph|journey|mindmap|timeline)/.test(
      trimmed
    )
  ) {
    return 'mermaid'
  }

  // JSON — starts with { or [
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      JSON.parse(code)
      return 'json'
    } catch {
      /* try heuristic */
    }
    if (/^\s*\{[\s\S]*"[\w]+"/.test(code)) return 'json'
  }

  // HTML/XML
  if (/^<[a-zA-Z!]/.test(trimmed) && /<\/\w+>/.test(code)) return 'html'

  // Shell
  if (
    /^(\$|#!\/|npm |yarn |pnpm |pip |brew |apt |curl |wget |git |cd |ls |mkdir |echo |export )/.test(
      trimmed
    )
  )
    return 'bash'

  // SQL
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s/i.test(trimmed)) return 'sql'

  // CSS
  if (/^[.#@]?[\w-]+\s*\{[\s\S]*:\s*[\s\S]*\}/.test(trimmed)) return 'css'

  // Python
  if (/^(def |class |import |from |if __name__|@\w+)/.test(trimmed)) return 'python'

  // TypeScript/JavaScript
  if (
    /^(const |let |var |function |import |export |interface |type |class |async |await )/.test(
      trimmed
    )
  )
    return 'typescript'

  return ''
}

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
  const explicitLang = langMatch ? langMatch[1] : ''

  // Extract code text: <code> child first, fallback to recursive extraction
  const rawChildren = (codeChild?.props as { children?: React.ReactNode })?.children
  const codeText = (
    rawChildren != null ? String(rawChildren) : extractTextContent(children)
  ).replace(/\n$/, '')

  const language = explicitLang || detectLanguage(codeText)

  const prismTheme = useMemo(() => PRISM_THEME_MAP[appTheme] ?? themes.nightOwl, [appTheme])

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(codeText)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
    <div
      data-testid="code-block"
      className="relative group my-2 rounded-lg overflow-x-auto overflow-y-hidden border border-border-subtle"
    >
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
              className="p-3 text-sm"
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

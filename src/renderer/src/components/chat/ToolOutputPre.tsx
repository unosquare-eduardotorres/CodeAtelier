/**
 * ToolOutputPre — syntax-highlighted replacement for the plain <pre> in the
 * chat tool-activity expand panel.
 *
 * Tool outputs decorate lines with prefixes (Claude Read gutters, grep
 * locators) that must not be tokenized — those render as muted spans and only
 * the content gets prism highlighting via the shared lazy grammar loader.
 * Falls back to the plain <pre> for error output (the danger tint is the
 * signal) and for oversized payloads where tokenization would stall.
 */
import { useMemo } from 'react'
import { Highlight, themes, type PrismTheme } from 'prism-react-renderer'
import { useAppTheme } from '@renderer/store'
import { usePrismGrammar } from '@renderer/hooks/use-prism-grammar'
import { parseToolOutputLine } from '@renderer/utils/tool-output-lines'

/** Map app theme → Prism highlight theme (mirrors CodeBlock/FileViewerPanel). */
const PRISM_THEME_MAP: Record<string, PrismTheme> = {
  'code-atelier': themes.nightOwl,
  glass: themes.nightOwl,
  porcelain: themes.vsLight,
  developer: themes.vsDark
}

/** Beyond this many lines, per-line tokenization costs more than it returns. */
const MAX_HIGHLIGHT_LINES = 1500

const PRE_CLASS = 'text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed'

export interface ToolOutputPreProps {
  text: string
  /** Language id ('' or 'text' = plain). */
  language?: string
  className?: string
}

export default function ToolOutputPre({
  text,
  language = '',
  className = ''
}: ToolOutputPreProps): React.JSX.Element {
  const appTheme = useAppTheme()
  const wantsHighlight = Boolean(language) && language !== 'text'
  const lines = useMemo(() => text.split('\n'), [text])
  const plain = !wantsHighlight || lines.length > MAX_HIGHLIGHT_LINES
  const grammarReady = usePrismGrammar(plain ? '' : language)

  // Plain path — same <pre> the panel used before highlighting existed.
  if (plain) {
    return <pre className={`${PRE_CLASS} ${className}`}>{text}</pre>
  }

  const prismTheme = PRISM_THEME_MAP[appTheme] ?? themes.nightOwl
  const highlightLanguage = grammarReady ? language : 'text'

  return (
    <pre className={`${PRE_CLASS} ${className}`} style={{ background: 'transparent' }}>
      {lines.map((rawLine, i) => {
        const { gutter, path, content } = parseToolOutputLine(rawLine)
        // Re-attach each format's own separator: Read gutters use →, grep
        // locators use : — so the rendered line matches the raw output.
        const decorated = gutter ? `${gutter}→` : path ? `${path}:` : ''
        if (!decorated) {
          return <span key={i}>{rawLine === '' ? '\n' : rawLine}</span>
        }
        return (
          <span key={i}>
            <span className="text-text-muted opacity-60">{decorated}</span>
            <Highlight theme={prismTheme} code={content} language={highlightLanguage}>
              {({ tokens, getTokenProps }) => (
                <span className="whitespace-pre-wrap break-all">
                  {tokens.map((line, k) =>
                    line.map((token, j) => <span key={`${k}-${j}`} {...getTokenProps({ token })} />)
                  )}
                </span>
              )}
            </Highlight>
          </span>
        )
      })}
    </pre>
  )
}

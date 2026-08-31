import { useMemo } from 'react'
import { Highlight, themes, type PrismTheme } from 'prism-react-renderer'
import { Copy, Check, X, AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useAppTheme } from '@renderer/store'
import { copyTextToClipboard } from '@renderer/utils/clipboard'
import { useFileViewerStore } from '@renderer/store/file-viewer.store'
import FileLanguageIcon, { getExtensionForIcon } from '../common/FileLanguageIcon'

/** Map app theme → Prism highlight theme (mirrors CodeBlock). */
const PRISM_THEME_MAP: Record<string, PrismTheme> = {
  'code-atelier': themes.nightOwl,
  glass: themes.nightOwl,
  porcelain: themes.vsLight,
  developer: themes.vsDark
}

/** extension → prism language token. Only mappings that differ from the ext. */
const EXT_TO_PRISM_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  mdx: 'markdown',
  rb: 'ruby',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  gitignore: 'bash',
  editorconfig: 'ini',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  json: 'json',
  webmanifest: 'json',
  graphql: 'graphql',
  dart: 'dart',
  scala: 'scala'
}

/** Highlight cap — beyond this, Prism's per-line tokenization stalls the renderer. */
const MAX_HIGHLIGHT_LINES = 5_000

function resolvePrismLanguage(filePath: string): string {
  const ext = getExtensionForIcon(filePath)
  return EXT_TO_PRISM_LANG[ext] ?? (ext || 'text')
}

interface FileViewerPanelProps {
  /** Compact variant for embedding in a tab/drawer (default full-height). */
  className?: string
}

/**
 * Read-only code file viewer — header (lang icon + path + copy + close) over a
 * prism-highlighted, line-numbered body. Fed by fileViewer.store so any mount
 * point (chat Files tab, blueprint drawer) shows the same active file.
 */
export default function FileViewerPanel({ className }: FileViewerPanelProps): React.JSX.Element {
  const { activeFile, content, loading, error, close } = useFileViewerStore()
  const appTheme = useAppTheme()
  const [copied, setCopied] = useState(false)

  const prismTheme = useMemo(() => PRISM_THEME_MAP[appTheme] ?? themes.nightOwl, [appTheme])
  const language = useMemo(
    () => (activeFile ? resolvePrismLanguage(activeFile) : 'text'),
    [activeFile]
  )

  // Cap highlighted lines — a 50K-line generated file tokenized by Prism
  // freezes the renderer for seconds; plain text renders fine.
  const totalLines = useMemo(() => content.split('\n').length, [content])
  const highlightCapped = totalLines > MAX_HIGHLIGHT_LINES
  const displayContent = useMemo(
    () =>
      highlightCapped ? content.split('\n').slice(0, MAX_HIGHLIGHT_LINES).join('\n') : content,
    [content, highlightCapped]
  )

  const handleCopy = async (): Promise<void> => {
    if (await copyTextToClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (!activeFile) {
    return (
      <div
        className={`flex items-center justify-center h-full text-text-muted text-sm ${className ?? ''}`}
        data-testid="file-viewer-empty"
      >
        Select a file to view its contents
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-surface-base border border-border-subtle rounded-lg overflow-hidden ${className ?? ''}`}
      data-testid="file-viewer-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-surface-overlay/50 flex-shrink-0">
        <FileLanguageIcon filePath={activeFile} size={16} />
        <span
          className="font-mono text-[12px] text-text-secondary truncate min-w-0 flex-1"
          title={activeFile}
        >
          {activeFile}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 rounded text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
          title="Copy file contents"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={close}
          className="p-1 rounded text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
          title="Close viewer"
        >
          <X size={13} />
        </button>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 h-full text-text-muted text-sm">
          <Loader2 size={14} className="animate-spin" />
          Loading file…
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
          <AlertCircle size={20} className="text-danger" />
          <span className="text-[13px] text-danger/90 break-all">{error}</span>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {highlightCapped && (
            <div className="px-3 py-1.5 text-[11px] text-amber-400 bg-amber-400/5 border-b border-amber-400/20 flex-shrink-0">
              Showing first {MAX_HIGHLIGHT_LINES.toLocaleString()} lines of{' '}
              {totalLines.toLocaleString()} (syntax highlighting capped)
            </div>
          )}
          <Highlight theme={prismTheme} code={displayContent} language={language}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre
                className="text-[12px] leading-[1.55] font-mono m-0 p-0"
                style={{ background: 'transparent' }}
              >
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })} className="table-row">
                    <span className="table-cell select-none text-right pr-3 pl-3 opacity-40 w-[1%] whitespace-nowrap">
                      {i + 1}
                    </span>
                    <span className="table-cell pr-4 whitespace-pre">
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  </div>
                ))}
              </pre>
            )}
          </Highlight>
        </div>
      )}
    </div>
  )
}

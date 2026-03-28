import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertTriangle, Copy, Check } from 'lucide-react'

interface MermaidDiagramProps {
  definition: string
  id?: string
  className?: string
}

/**
 * Lazily loads and initializes the mermaid library in the renderer process.
 * Rendering happens client-side in real Chromium DOM — no JSDOM limitations.
 *
 * Mermaid v11 is ESM-only. When bundled by electron-vite the default export
 * may be nested under `.default`, so we handle both shapes.
 */
let mermaidInstance: typeof import('mermaid').default | null = null
let mermaidReady: Promise<typeof import('mermaid').default> | null = null

function getMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidInstance) return Promise.resolve(mermaidInstance)
  if (mermaidReady) return mermaidReady

  mermaidReady = import('mermaid').then((mod) => {
    const m = (mod.default as unknown as { default: typeof mod.default }).default ?? mod.default
    m.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'ui-monospace, monospace'
    })
    mermaidInstance = m
    return m
  })

  return mermaidReady
}

let renderCounter = 0

export default function MermaidDiagram({
  definition,
  id,
  className
}: MermaidDiagramProps): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const diagramId = id ?? `mermaid-r-${++renderCounter}`

    getMermaid()
      .then((mermaid) => mermaid.render(diagramId, definition.trim()))
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(renderedSvg)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError((err as Error).message)
          setLoading(false)
        }
      })

    return (): void => {
      cancelled = true
    }
  }, [definition, id])

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(definition)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }, [definition])

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-8 ${className ?? ''}`}>
        <Loader2 size={20} className="animate-spin text-indigo-400" />
        <span className="ml-2 text-sm text-gray-400">Rendering diagram...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`rounded-lg border border-red-500/30 bg-red-500/5 p-4 ${className ?? ''}`}>
        <div className="flex items-center gap-2 text-red-400 text-sm mb-2">
          <AlertTriangle size={14} />
          <span>Failed to render diagram</span>
        </div>
        <pre className="text-xs text-gray-500 whitespace-pre-wrap">{error}</pre>
      </div>
    )
  }

  return (
    <div className={`relative group ${className ?? ''}`}>
      {/* Copy source button */}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10
                   flex items-center gap-1 px-2 py-1 rounded-md bg-gray-800/80 text-xs text-gray-400 hover:text-gray-200"
      >
        {copied ? (
          <>
            <Check size={12} className="text-green-400" />
            <span className="text-green-400">Copied</span>
          </>
        ) : (
          <>
            <Copy size={12} />
            <span>Copy source</span>
          </>
        )}
      </button>
      {/* Rendered SVG */}
      <div
        ref={containerRef}
        className="overflow-auto bg-gray-950 rounded-lg p-4 [&_svg]:max-w-full [&_svg]:h-auto"
        dangerouslySetInnerHTML={{ __html: svg ?? '' }}
      />
    </div>
  )
}

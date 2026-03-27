import { useState, useEffect, useRef } from 'react'
import { Loader2, AlertTriangle, Copy, Check } from 'lucide-react'

interface MermaidDiagramProps {
  definition: string
  id?: string
  className?: string
}

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

    window.api
      .renderMermaid({ definition, id })
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg)
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

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(definition)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

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

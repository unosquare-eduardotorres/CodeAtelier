import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertTriangle, Copy, Check, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'

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
      securityLevel: 'loose', // 'strict' blocks gitGraph and some other diagram types
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      themeVariables: {
        primaryColor: '#1E2E33',
        primaryTextColor: '#C8B89A',
        primaryBorderColor: 'rgba(184, 151, 106, 0.3)',
        lineColor: '#B8976A',
        secondaryColor: '#283337',
        tertiaryColor: '#1C272D',
        noteBkgColor: '#283337',
        noteTextColor: '#8A9A9E',
        actorBkg: '#1E2E33',
        actorBorder: 'rgba(184, 151, 106, 0.3)',
        actorTextColor: '#C8B89A',
        signalColor: '#B8976A',
        labelBoxBkgColor: '#1C272D',
        labelTextColor: '#C8B89A'
      }
    })
    mermaidInstance = m
    return m
  })

  return mermaidReady
}

let renderCounter = 0

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const ZOOM_STEP_CLICK = 0.1
const ZOOM_STEP_WHEEL = 0.05
const FIT_PADDING = 16

export default function MermaidDiagram({
  definition,
  id,
  className
}: MermaidDiagramProps): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  // Pan + Zoom state
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)

  const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current
    const svgEl = viewport?.querySelector('svg')
    if (!viewport || !svgEl) return

    const vw = viewport.clientWidth - FIT_PADDING * 2
    const vh = viewport.clientHeight - FIT_PADDING * 2
    const sw = svgEl.scrollWidth || svgEl.clientWidth
    const sh = svgEl.scrollHeight || svgEl.clientHeight

    if (sw === 0 || sh === 0) return

    const fitScale = Math.min(1, vw / sw, vh / sh)
    setScale(fitScale)
    setTranslate({
      x: (vw + FIT_PADDING * 2 - sw * fitScale) / 2,
      y: (vh + FIT_PADDING * 2 - sh * fitScale) / 2
    })
  }, [])

  // Render mermaid diagram
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
          // Fit-to-view after DOM paints the SVG
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              fitToView()
            })
          })
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
  }, [definition, id, fitToView])

  // Wheel handler — zoom toward cursor position
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -ZOOM_STEP_WHEEL : ZOOM_STEP_WHEEL

      setScale((prev) => {
        const next = clampScale(prev + delta)
        const rect = viewport.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const factor = next / prev

        setTranslate((t) => ({
          x: cx - factor * (cx - t.x),
          y: cy - factor * (cy - t.y)
        }))

        return next
      })
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return (): void => {
      viewport.removeEventListener('wheel', handleWheel)
    }
  }, [])

  // Mouse drag handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      setIsDragging(true)
      dragStart.current = { x: e.clientX - translate.x, y: e.clientY - translate.y }
    },
    [translate]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      setTranslate({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y
      })
    },
    [isDragging]
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Toolbar zoom controls
  const handleZoomIn = useCallback(() => {
    setScale((prev) => {
      const next = clampScale(prev + ZOOM_STEP_CLICK)
      const viewport = viewportRef.current
      if (viewport) {
        const rect = viewport.getBoundingClientRect()
        const cx = rect.width / 2
        const cy = rect.height / 2
        const factor = next / prev
        setTranslate((t) => ({
          x: cx - factor * (cx - t.x),
          y: cy - factor * (cy - t.y)
        }))
      }
      return next
    })
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale((prev) => {
      const next = clampScale(prev - ZOOM_STEP_CLICK)
      const viewport = viewportRef.current
      if (viewport) {
        const rect = viewport.getBoundingClientRect()
        const cx = rect.width / 2
        const cy = rect.height / 2
        const factor = next / prev
        setTranslate((t) => ({
          x: cx - factor * (cx - t.x),
          y: cy - factor * (cy - t.y)
        }))
      }
      return next
    })
  }, [])

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(definition)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      // Fallback: textarea + execCommand for restricted Electron contexts
      try {
        const textarea = document.createElement('textarea')
        textarea.value = definition
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch (fallbackErr) {
        console.error('MermaidDiagram: clipboard copy failed', err, fallbackErr)
      }
    }
  }, [definition])

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-8 ${className ?? ''}`}>
        <Loader2 size={20} className="animate-spin text-info" />
        <span className="ml-2 text-sm text-text-secondary">Rendering diagram...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`rounded-lg border border-danger/30 bg-danger-muted p-4 ${className ?? ''}`}>
        <div className="flex items-center gap-2 text-danger text-sm mb-2">
          <AlertTriangle size={14} />
          <span>Failed to render diagram</span>
        </div>
        <pre className="text-xs text-text-muted whitespace-pre-wrap">{error}</pre>
      </div>
    )
  }

  const toolbarBtnClass =
    'px-1.5 py-1 rounded bg-surface-overlay/80 text-text-secondary hover:text-text-primary transition-colors'

  return (
    <div className={`relative group ${className ?? ''}`}>
      {/* Toolbar — zoom controls + copy */}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button onClick={handleZoomOut} className={toolbarBtnClass} title="Zoom out">
          <ZoomOut size={12} />
        </button>
        <span className="text-[10px] font-mono text-text-secondary min-w-[36px] text-center select-none">
          {Math.round(scale * 100)}%
        </span>
        <button onClick={handleZoomIn} className={toolbarBtnClass} title="Zoom in">
          <ZoomIn size={12} />
        </button>
        <button onClick={fitToView} className={toolbarBtnClass} title="Fit to view">
          <Maximize2 size={12} />
        </button>
        <div className="w-px h-4 bg-border-subtle mx-0.5" />
        <button
          onClick={handleCopy}
          className={`${toolbarBtnClass} flex items-center gap-1`}
          title="Copy source"
        >
          {copied ? (
            <>
              <Check size={12} className="text-success" />
              <span className="text-[10px] text-success">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span className="text-[10px]">Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Interactive viewport — pan & zoom */}
      <div
        ref={viewportRef}
        className="overflow-hidden bg-surface-base rounded-lg"
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          minHeight: '200px'
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            transition: isDragging ? 'none' : 'transform 0.15s ease-out'
          }}
          className="[&_svg]:max-w-none [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svg ?? '' }}
        />
      </div>
    </div>
  )
}

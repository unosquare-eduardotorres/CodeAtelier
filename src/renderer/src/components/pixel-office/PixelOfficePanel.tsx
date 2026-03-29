import { useCallback, useRef, useEffect } from 'react'
import { Minus, Maximize2, ExternalLink } from 'lucide-react'
import { usePixelOfficeStore } from '@renderer/store/pixelOffice.store'
import PhaserOfficeCanvas from './PhaserOfficeCanvas'

export default function PixelOfficePanel(): React.JSX.Element {
  const { panelHeight, setPanelHeight, hidePanel } = usePixelOfficeStore()
  const panelRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  // ── Resize handle drag ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startY.current = e.clientY
      startHeight.current = panelHeight
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [panelHeight]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDragging.current) return
      // Dragging up increases height (startY > clientY means moving up)
      const delta = startY.current - e.clientY
      setPanelHeight(startHeight.current + delta)
    }

    const handleMouseUp = (): void => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setPanelHeight])

  return (
    <div
      ref={panelRef}
      className="flex-shrink-0 bg-[#0f0e17] border-t border-[#3d3555] flex flex-col overflow-hidden transition-[height] duration-200"
      style={{ height: panelHeight }}
    >
      {/* Resize handle */}
      <div
        className="h-1 cursor-row-resize bg-[#3d3555]/50 hover:bg-indigo-500/50 transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1 bg-[#1a1828]/80 border-b border-[#3d3555]/50 flex-shrink-0">
        <span className="text-xs font-medium text-gray-400 flex items-center gap-2">
          <span className="text-base">🏰</span>
          Pixel Office
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              await window.api.popoutPixelOffice()
            }}
            className="p-0.5 rounded hover:bg-[#2a2844] text-gray-500 hover:text-gray-300 transition-colors"
            title="Open in separate window"
            aria-label="Pop out to separate window"
          >
            <ExternalLink size={11} />
          </button>
          <button
            onClick={() => setPanelHeight(panelHeight < 400 ? 500 : 300)}
            className="p-0.5 rounded hover:bg-[#2a2844] text-gray-500 hover:text-gray-300 transition-colors"
            title={panelHeight < 400 ? 'Expand' : 'Shrink'}
            aria-label="Resize panel"
          >
            <Maximize2 size={11} />
          </button>
          <button
            onClick={hidePanel}
            className="p-0.5 rounded hover:bg-[#2a2844] text-gray-500 hover:text-gray-300 transition-colors"
            title="Minimize"
            aria-label="Minimize panel"
          >
            <Minus size={11} />
          </button>
        </div>
      </div>

      {/* Canvas container */}
      <div className="flex-1 min-h-0 relative bg-[#0a0a14]">
        <PhaserOfficeCanvas />
      </div>
    </div>
  )
}

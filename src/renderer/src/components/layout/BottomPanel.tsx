import { useCallback, useRef, useEffect } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { useBottomPanelStore } from '@renderer/store'
import { useAgentStore } from '@renderer/store'
import { AgentMonitor } from '@renderer/components/agents'
import { PhaserOfficeCanvas } from '@renderer/components/pixel-office'
import { ErrorBoundary } from '@renderer/components/common'

export default function BottomPanel(): React.JSX.Element | null {
  const { activeTab, panelHeight, toggleTab, closePanel, setPanelHeight, setDragging } =
    useBottomPanelStore()

  const activeAgentCount = useAgentStore(
    (s) =>
      s.statuses.filter(
        (st) => st.status === 'thinking' || st.status === 'writing' || st.status === 'reviewing'
      ).length
  )

  const isDragging = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startY.current = e.clientY
      startHeight.current = panelHeight
      setDragging(true)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [panelHeight, setDragging]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDragging.current) return
      const delta = startY.current - e.clientY
      setPanelHeight(startHeight.current + delta)
    }

    const handleMouseUp = (): void => {
      if (!isDragging.current) return
      isDragging.current = false
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setPanelHeight, setDragging])

  if (!activeTab) return null

  return (
    <div
      className="flex-shrink-0 border-t border-border-subtle flex flex-col overflow-hidden"
      style={{ height: panelHeight }}
    >
      {/* Resize drag handle */}
      <div
        className="h-1 cursor-row-resize bg-border-subtle/50 hover:bg-primary/50 transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />

      {/* Tab header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-raised border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => toggleTab('agents')}
            className={`text-xs font-medium px-2.5 py-1 rounded transition-colors ${
              activeTab === 'agents'
                ? 'bg-surface-overlay text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/50'
            }`}
          >
            Agents{activeAgentCount > 0 ? ` (${activeAgentCount})` : ''}
          </button>
          <button
            onClick={() => toggleTab('office')}
            className={`text-xs font-medium px-2.5 py-1 rounded transition-colors ${
              activeTab === 'office'
                ? 'bg-surface-overlay text-text-primary'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/50'
            }`}
          >
            Office
          </button>
        </div>

        <div className="flex items-center gap-1">
          {activeTab === 'office' && (
            <button
              onClick={async () => {
                await window.api.popoutPixelOffice()
              }}
              className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
              title="Open in separate window"
              aria-label="Pop out to separate window"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            onClick={closePanel}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close panel"
            title="Close panel"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'agents' && (
          <ErrorBoundary
            fallback={
              <div className="flex items-center justify-center p-4 text-sm text-danger bg-surface-raised">
                Agent panel error — click to retry
              </div>
            }
          >
            <AgentMonitor variant="bottom" />
          </ErrorBoundary>
        )}
        {activeTab === 'office' && (
          <ErrorBoundary
            fallback={
              <div className="p-4 text-sm text-danger bg-surface-raised">
                Pixel Office error — click to retry
              </div>
            }
          >
            <div className="h-full bg-[#0a0a14]">
              <PhaserOfficeCanvas />
            </div>
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}

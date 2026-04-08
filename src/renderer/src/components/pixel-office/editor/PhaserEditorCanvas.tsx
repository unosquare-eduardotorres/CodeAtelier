/**
 * PhaserEditorCanvas — React wrapper for the Phaser editor scene.
 * Creates a Phaser.Game with PhaserEditorScene and exposes editor callbacks.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import Phaser from 'phaser'
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react'

import { PhaserEditorScene } from './PhaserEditorScene'
import type { EditorState } from './editorState'
import type { OfficeLayout } from '../engine/types'
import { TILE_SIZE } from '../engine/types'
import type { OfficeState } from '../engine/officeState'

const MIN_ZOOM = 1
const MAX_ZOOM = 10
const DEFAULT_ZOOM = 2

interface PhaserEditorCanvasProps {
  layout?: OfficeLayout | null
  editorState: EditorState
  editorTick: number
  onTileAction: (col: number, row: number) => void
  onEraseAction: (col: number, row: number) => void
  onSelectionChange: () => void
  onDragMove: (uid: string, newCol: number, newRow: number) => void
  getOfficeStateRef: React.MutableRefObject<(() => OfficeState) | null>
}

export default function PhaserEditorCanvas({
  layout,
  editorState,
  editorTick,
  onTileAction,
  onEraseAction,
  onSelectionChange,
  onDragMove,
  getOfficeStateRef
}: PhaserEditorCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)
  const sceneRef = useRef<PhaserEditorScene | null>(null)

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM)
  const zoomRef = useRef(DEFAULT_ZOOM)

  // ── Initialize Phaser Game ──
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()

    const scene = new PhaserEditorScene()
    scene.setLayout(layout ?? null)
    scene.setEditorState(editorState)
    scene.setCallbacks({
      onTileAction,
      onEraseAction,
      onSelectionChange,
      onDragMove
    })
    sceneRef.current = scene

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: Math.floor(rect.width) || 768,
      height: Math.floor(rect.height) || 480,
      backgroundColor: '#0a0a14',
      scene: scene,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.NONE
      },
      input: {
        mouse: {
          preventDefaultWheel: true
        }
      },
      render: {
        antialias: true,
        pixelArt: false,
        roundPixels: true
      }
    })

    gameRef.current = game

    game.events.once('ready', () => {
      const activeScene = game.scene.getScene('PhaserEditorScene')
      if (activeScene) {
        activeScene.cameras.main.setZoom(DEFAULT_ZOOM)
      }
    })

    // Expose getOfficeState via ref so useEditorActions can call it
    getOfficeStateRef.current = () => {
      const os = sceneRef.current?.getOfficeState()
      if (!os) throw new Error('OfficeState not initialized')
      return os
    }

    return () => {
      game.destroy(true)
      gameRef.current = null
      sceneRef.current = null
      getOfficeStateRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // ── Redraw when editorTick changes (layout modified) ──
  useEffect(() => {
    sceneRef.current?.redraw()
  }, [editorTick])

  // ── Handle container resize ──
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const game = gameRef.current
      if (!game) return
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        game.scale.resize(Math.floor(width), Math.floor(height))
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ── Zoom controls ──
  const changeZoom = useCallback((delta: number) => {
    const game = gameRef.current
    if (!game) return

    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current + delta))
    zoomRef.current = newZoom
    setZoomLevel(newZoom)

    const scene = game.scene.getScene('PhaserEditorScene')
    if (scene) {
      scene.cameras.main.setZoom(newZoom)
    }
  }, [])

  const fitToView = useCallback(() => {
    const game = gameRef.current
    const container = containerRef.current
    const scene = sceneRef.current
    if (!game || !container || !scene) return

    const officeState = scene.getOfficeState()
    if (!officeState) return

    const rect = container.getBoundingClientRect()
    const layoutData = officeState.getLayout()
    const officeWidthPx = layoutData.cols * TILE_SIZE
    const officeHeightPx = layoutData.rows * TILE_SIZE

    const padding = 40
    const zoomX = (rect.width - padding * 2) / officeWidthPx
    const zoomY = (rect.height - padding * 2) / officeHeightPx
    const fitZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.floor(Math.min(zoomX, zoomY) * 2) / 2)
    )

    zoomRef.current = fitZoom
    setZoomLevel(fitZoom)

    const activeScene = game.scene.getScene('PhaserEditorScene')
    if (activeScene) {
      activeScene.cameras.main.setZoom(fitZoom)
      activeScene.cameras.main.centerOn(officeWidthPx / 2, officeHeightPx / 2)
    }
  }, [])

  // ── Fit to view on initial mount ──
  useEffect(() => {
    const timer = setTimeout(() => fitToView(), 500)
    return () => clearTimeout(timer)
  }, [fitToView])

  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ overflow: 'hidden' }}>
      {/* Phaser creates its canvas here */}

      {/* Zoom controls overlay */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-surface-base/90 backdrop-blur-sm rounded-lg px-1.5 py-1 border border-border-subtle z-10">
        <button
          onClick={() => changeZoom(-0.5)}
          className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[10px] text-text-muted w-8 text-center font-mono tabular-nums">
          {zoomLevel}x
        </span>
        <button
          onClick={() => changeZoom(0.5)}
          className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-border-subtle mx-0.5" />
        <button
          onClick={fitToView}
          className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
          title="Fit to view"
        >
          <Maximize size={14} />
        </button>
      </div>

      {/* Status text */}
      <div className="absolute top-2 left-3 text-[10px] text-text-muted/50 z-10">
        Middle-click to pan · Scroll to zoom · Right-click to erase
      </div>
    </div>
  )
}

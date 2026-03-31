/**
 * PhaserOfficeCanvas — React wrapper that creates and manages a Phaser.Game instance.
 *
 * Follows the Outworked pattern: scene instance is passed directly to Phaser.Game,
 * not via method bindings. Layout data is set on the scene before game init.
 *
 * Uses Phaser 3 engine exclusively — Canvas 2D fallback has been removed.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import Phaser from 'phaser'
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react'

import { PhaserOfficeScene } from './phaser'
import type { PixelOfficeEngine } from '@renderer/hooks/usePixelOfficeBridge'
import { usePixelOfficeBridge } from '@renderer/hooks/usePixelOfficeBridge'
import type { OfficeLayout } from './engine/types'
import { TILE_SIZE } from './engine/types'

const MIN_ZOOM = 1
const MAX_ZOOM = 10
const DEFAULT_ZOOM = 2

interface PhaserOfficeCanvasProps {
  layout?: OfficeLayout | null
}

export default function PhaserOfficeCanvas({ layout }: PhaserOfficeCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)
  const sceneRef = useRef<PhaserOfficeScene | null>(null)
  const engineRef = useRef<PixelOfficeEngine | null>(null)

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM)
  const zoomRef = useRef(DEFAULT_ZOOM)

  // ── Initialize Phaser Game ──
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()

    // Create scene instance and pass layout data BEFORE Phaser init (Outworked pattern)
    const scene = new PhaserOfficeScene()
    scene.setLayout(layout ?? null)
    sceneRef.current = scene

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: Math.floor(rect.width) || 768,
      height: Math.floor(rect.height) || 480,
      backgroundColor: '#0F1517',
      scene: scene, // Pass instance directly — no bind() hack
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.NONE // Outworked pattern — simpler camera model
      },
      input: {
        mouse: {
          preventDefaultWheel: true // Prevent scroll from reaching parent
        }
      },
      render: {
        antialias: true,
        pixelArt: false, // Allow anti-aliased text rendering
        roundPixels: true // Prevents sub-pixel sprite jitter
      }
    })

    gameRef.current = game

    // Wait for Phaser to fully boot before accessing scene internals
    game.events.once('ready', () => {
      const activeScene = game.scene.getScene('PhaserOfficeScene')
      if (activeScene) {
        activeScene.cameras.main.setZoom(DEFAULT_ZOOM)
        // Enable drag-to-pan with any mouse button
        activeScene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
          if (pointer.leftButtonDown()) {
            activeScene.input.mouse?.disableContextMenu()
          }
        })
      }

      // Build the engine interface once scene.events is available
      // scene.events is only initialized after Phaser boots, so this must
      // live inside the 'ready' callback — not at the top level
      scene.events.once('create', () => {
        engineRef.current = {
          addAgent(_id, numericId, spriteIndex, hueShift, seatIndex, displayName, pixelSpriteId) {
            sceneRef.current?.addAgent(numericId, spriteIndex, hueShift, seatIndex, displayName, pixelSpriteId)
          },
          removeAgent(numericId) {
            sceneRef.current?.removeAgent(numericId)
          },
          setAgentActive(numericId, active) {
            sceneRef.current?.setAgentActive(numericId, active)
          },
          setAgentTool(numericId, toolName) {
            sceneRef.current?.setAgentTool(numericId, toolName)
          },
          showPermissionBubble(numericId, _text) {
            sceneRef.current?.showPermissionBubble(numericId)
          },
          clearPermissionBubble(numericId) {
            sceneRef.current?.clearPermissionBubble(numericId)
          },
          getTotalSeats() {
            return sceneRef.current?.getTotalSeats() ?? 0
          },
          getAgentNumericId() {
            return undefined
          },
          getPlaceholderNumericId(agentType) {
            return sceneRef.current?.getPlaceholderNumericId(agentType)
          },
          removePlaceholder(agentType) {
            sceneRef.current?.removePlaceholder(agentType)
          },
          restorePlaceholder(agentType) {
            sceneRef.current?.restorePlaceholder(agentType)
          },
          setAgentThought(numericId, thought) {
            sceneRef.current?.setAgentThought(numericId, thought)
          },
          updateDisplayName(numericId, name) {
            sceneRef.current?.updateAgentDisplayName(numericId, name)
          }
        }
      })
    })

    return () => {
      game.destroy(true)
      gameRef.current = null
      sceneRef.current = null
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

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

    // Apply zoom to Phaser camera
    const scene = game.scene.getScene('PhaserOfficeScene')
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

    const padding = 20
    const zoomX = (rect.width - padding * 2) / officeWidthPx
    const zoomY = (rect.height - padding * 2) / officeHeightPx
    const fitZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min(zoomX, zoomY))))

    zoomRef.current = fitZoom
    setZoomLevel(fitZoom)

    const activeScene = game.scene.getScene('PhaserOfficeScene')
    if (activeScene) {
      activeScene.cameras.main.setZoom(fitZoom)
      // Center on office
      activeScene.cameras.main.centerOn(officeWidthPx / 2, officeHeightPx / 2)
    }
  }, [])

  // ── Bridge hook ──
  usePixelOfficeBridge(engineRef)

  // ── Fit to view on initial mount ──
  useEffect(() => {
    // Wait for Phaser to initialize and scene to be ready
    const timer = setTimeout(() => fitToView(), 500)
    return () => clearTimeout(timer)
  }, [fitToView])

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative"
      style={{ overflow: 'hidden', cursor: 'grab' }}
    >
      {/* Phaser creates its canvas inside this div */}

      {/* Zoom controls overlay — dark renaissance palette */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-[#1a1828]/90 backdrop-blur-sm rounded-lg px-1.5 py-1 border border-[#3d3555]/60 z-10">
        <button
          onClick={() => changeZoom(-0.5)}
          className="p-1 rounded hover:bg-[#2a2844] text-[#8b7fb0] hover:text-[#c8b8e8] transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[10px] text-[#8b7fb0] w-8 text-center font-mono">
          {zoomLevel}x
        </span>
        <button
          onClick={() => changeZoom(0.5)}
          className="p-1 rounded hover:bg-[#2a2844] text-[#8b7fb0] hover:text-[#c8b8e8] transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-[#3d3555] mx-0.5" />
        <button
          onClick={fitToView}
          className="p-1 rounded hover:bg-[#2a2844] text-[#8b7fb0] hover:text-[#c8b8e8] transition-colors"
          title="Fit to view"
        >
          <Maximize size={14} />
        </button>
      </div>

      {/* Info text overlay */}
      <div className="absolute top-2 left-3 text-[10px] text-[#4a4268] z-10">
        Drag to pan · Phaser 3 Engine
      </div>
    </div>
  )
}

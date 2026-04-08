/**
 * PhaserEditorScene — Phaser 3 scene for the office layout editor.
 *
 * Extends PhaserOfficeScene concepts with:
 * - Grid overlay with dashed lines at tile boundaries
 * - Ghost preview sprite following mouse (green=valid, red=invalid)
 * - Click/drag handlers routed through EditorState
 * - Selection highlight for selected furniture
 * - No agent AI — characters not rendered in editor mode
 */

import Phaser from 'phaser'
import { loadAllAssets } from '../assetLoader'
import { OfficeState } from '../engine/officeState'
import type { OfficeLayout, SpriteData, FurnitureInstance } from '../engine/types'
import { TILE_SIZE } from '../engine/types'
import { deserializeLayout } from '../layout/layoutSerializer'
import { getCatalogEntry } from '../layout/furnitureCatalog'
import { registerSpriteDataTexture } from '../phaser/PhaserSpriteLoader'
import {
  drawWalls as drawWallsShared,
  drawFloorTiles,
  createFurnitureSprites as createFurnitureSpritesShared,
  clearFurnitureSprites
} from '../phaser/renderUtils'
import type { EditorState } from './editorState'
import { EditTool } from '../engine/types'
import { canPlaceFurniture, findFurnitureAtTile, getWallPlacementRow } from './editorActions'
import { setupEditorInput } from './input/EditorInputHandler'
import type { EditorInputCallbacks } from './input/types'
import defaultLayoutJson from '@renderer/assets/pixel-office/default-layout.json'

// Grid overlay
const GRID_LINE_COLOR = 0xffffff
const GRID_LINE_ALPHA = 0.08
const GHOST_BORDER_ALPHA = 0.04

// Selection highlight
const SELECTION_COLOR = 0x007fd4
const SELECTION_ALPHA = 0.5
const SELECTION_LINE_WIDTH = 1

// Ghost preview
const GHOST_VALID_TINT = 0x00ff00
const GHOST_INVALID_TINT = 0xff0000
export class PhaserEditorScene extends Phaser.Scene {
  private officeState: OfficeState | null = null
  private pendingLayout: OfficeLayout | null = null
  private editorState: EditorState | null = null
  private callbacks: EditorInputCallbacks = {}

  // Graphics layers
  private floorGraphics: Phaser.GameObjects.Graphics | null = null
  private gridGraphics: Phaser.GameObjects.Graphics | null = null
  private selectionGraphics: Phaser.GameObjects.Graphics | null = null
  private ghostGraphics: Phaser.GameObjects.Graphics | null = null

  // Furniture sprites
  private furnitureSprites: Phaser.GameObjects.Image[] = []
  private furnitureTextureCache = new Map<SpriteData, string>()
  private readonly furnitureTexCounterObj = { value: 0 }
  private lastFurnitureRef: readonly FurnitureInstance[] | null = null

  // State flags
  private assetsLoaded = false
  private showGrid = true
  private isDragging = false

  // Layout change tracking — detect when rebuildFromLayout creates new layout ref
  private lastLayoutRef: OfficeLayout | null = null

  constructor() {
    super({ key: 'PhaserEditorScene' })
  }

  // ═══════════════════════════════════════════════════════════════
  // Pre-init API
  // ═══════════════════════════════════════════════════════════════

  setLayout(layout: OfficeLayout | null | undefined): void {
    this.pendingLayout = layout ?? null
  }

  setEditorState(state: EditorState): void {
    this.editorState = state
  }

  setCallbacks(callbacks: EditorInputCallbacks): void {
    this.callbacks = callbacks
  }

  setShowGrid(show: boolean): void {
    this.showGrid = show
    this.drawGrid()
  }

  getOfficeState(): OfficeState | null {
    return this.officeState
  }

  // ═══════════════════════════════════════════════════════════════
  // Phaser lifecycle
  // ═══════════════════════════════════════════════════════════════

  async create(): Promise<void> {
    await loadAllAssets()
    this.assetsLoaded = true

    const layout =
      this.pendingLayout || deserializeLayout(JSON.stringify(defaultLayoutJson)) || undefined
    this.officeState = new OfficeState(layout)
    this.lastLayoutRef = this.officeState.getLayout()

    this.drawOffice()
    this.createFurniture()
    this.drawGrid()

    // Initialize selection and ghost graphics
    this.selectionGraphics = this.add.graphics().setDepth(100)
    this.ghostGraphics = this.add.graphics().setDepth(99)

    // Center camera
    const layoutData = this.officeState.getLayout()
    const worldW = layoutData.cols * TILE_SIZE
    const worldH = layoutData.rows * TILE_SIZE
    this.cameras.main.centerOn(worldW / 2, worldH / 2)

    // ── Input handlers ──
    setupEditorInput({
      scene: this,
      getEditorState: () => this.editorState,
      getCallbacks: () => this.callbacks,
      findFurnitureAtTile: (col, row) => this.findFurnitureAtTileLocal(col, row),
      updateCursor: () => this.updateCursor(),
      setIsDragging: (d) => {
        this.isDragging = d
      },
      getIsDragging: () => this.isDragging
    })
    this.updateCursor()
  }

  update(_time: number, _deltaMs: number): void {
    if (!this.officeState || !this.assetsLoaded) return

    // Detect layout changes (floor color, wall color, furniture placement via rebuildFromLayout)
    const currentLayout = this.officeState.getLayout()
    if (currentLayout !== this.lastLayoutRef) {
      this.lastLayoutRef = currentLayout
      this.redraw() // Full repaint: floor + walls + furniture + grid
    }

    this.updateFurniture()
    this.drawSelection()
    this.drawGhostPreview()
  }

  // ═══════════════════════════════════════════════════════════════
  // Public: Redraw after layout changes
  // ═══════════════════════════════════════════════════════════════

  redraw(): void {
    if (!this.officeState || !this.assetsLoaded) return

    // Destroy old graphics
    this.floorGraphics?.destroy()
    this.gridGraphics?.destroy()
    this.floorGraphics = null
    this.gridGraphics = null

    // Force furniture rebuild
    this.lastFurnitureRef = null

    this.drawOffice()
    this.createFurniture()
    this.drawGrid()
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Drawing
  // ═══════════════════════════════════════════════════════════════

  private drawOffice(): void {
    const office = this.officeState
    if (!office) return

    const layout = office.getLayout()
    const tileMap = office.tileMap

    const g = this.add.graphics()
    this.floorGraphics = g
    g.setDepth(-1)

    const rows = tileMap.length
    const cols = rows > 0 ? tileMap[0].length : 0

    // Floor tiles (shared)
    drawFloorTiles(g, tileMap, layout)

    // Walls
    this.drawWalls(g, tileMap, rows, cols)
  }

  private drawWalls(
    g: Phaser.GameObjects.Graphics,
    tileMap: number[][],
    rows: number,
    cols: number
  ): void {
    drawWallsShared(g, tileMap, rows, cols)
  }

  private drawGrid(): void {
    this.gridGraphics?.destroy()
    if (!this.showGrid || !this.officeState) return

    const g = this.add.graphics()
    this.gridGraphics = g
    g.setDepth(50)

    const layout = this.officeState.getLayout()
    const { cols, rows } = layout

    // Draw grid lines
    g.lineStyle(1, GRID_LINE_COLOR, GRID_LINE_ALPHA)

    // Vertical lines
    for (let c = 0; c <= cols; c++) {
      g.lineBetween(c * TILE_SIZE, 0, c * TILE_SIZE, rows * TILE_SIZE)
    }
    // Horizontal lines
    for (let r = 0; r <= rows; r++) {
      g.lineBetween(0, r * TILE_SIZE, cols * TILE_SIZE, r * TILE_SIZE)
    }

    // Ghost border tiles (expansion targets) — 1 tile outside grid
    g.lineStyle(1, GRID_LINE_COLOR, GHOST_BORDER_ALPHA)

    // Top ghost border
    for (let c = -1; c <= cols; c++) {
      g.strokeRect(c * TILE_SIZE, -TILE_SIZE, TILE_SIZE, TILE_SIZE)
    }
    // Bottom
    for (let c = -1; c <= cols; c++) {
      g.strokeRect(c * TILE_SIZE, rows * TILE_SIZE, TILE_SIZE, TILE_SIZE)
    }
    // Left
    for (let r = 0; r < rows; r++) {
      g.strokeRect(-TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE)
    }
    // Right
    for (let r = 0; r < rows; r++) {
      g.strokeRect(cols * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE)
    }
  }

  private drawSelection(): void {
    const g = this.selectionGraphics
    if (!g || !this.editorState || !this.officeState) return
    g.clear()

    const uid = this.editorState.selectedFurnitureUid
    if (!uid) return

    const layout = this.officeState.getLayout()
    const item = layout.furniture.find((f) => f.uid === uid)
    if (!item) return

    const entry = getCatalogEntry(item.type)
    if (!entry) return

    const x = item.col * TILE_SIZE
    const y = item.row * TILE_SIZE
    const w = entry.footprintW * TILE_SIZE
    const h = entry.footprintH * TILE_SIZE

    g.lineStyle(SELECTION_LINE_WIDTH, SELECTION_COLOR, SELECTION_ALPHA)
    g.strokeRect(x, y, w, h)
  }

  private drawGhostPreview(): void {
    const g = this.ghostGraphics
    if (!g || !this.editorState || !this.officeState) return
    g.clear()

    const es = this.editorState
    if (es.ghostCol < -1 || es.ghostRow < -1) return

    // Show ghost for furniture placement
    if (es.activeTool === EditTool.FURNITURE_PLACE && es.selectedFurnitureType) {
      const entry = getCatalogEntry(es.selectedFurnitureType)
      if (!entry) return

      const placementRow = getWallPlacementRow(es.selectedFurnitureType, es.ghostRow)
      const x = es.ghostCol * TILE_SIZE
      const y = placementRow * TILE_SIZE
      const w = entry.footprintW * TILE_SIZE
      const h = entry.footprintH * TILE_SIZE

      const valid = canPlaceFurniture(
        this.officeState.getLayout(),
        es.selectedFurnitureType,
        es.ghostCol,
        placementRow
      )

      const tint = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT
      g.fillStyle(tint, 0.15)
      g.fillRect(x, y, w, h)
      g.lineStyle(1, tint, 0.4)
      g.strokeRect(x, y, w, h)
    }

    // Show hover highlight for floor/wall/erase tools
    if (
      es.activeTool === EditTool.TILE_PAINT ||
      es.activeTool === EditTool.WALL_PAINT ||
      es.activeTool === EditTool.ERASE ||
      es.activeTool === EditTool.EYEDROPPER
    ) {
      if (es.ghostCol >= -1 && es.ghostRow >= -1) {
        const x = es.ghostCol * TILE_SIZE
        const y = es.ghostRow * TILE_SIZE
        g.fillStyle(0xffffff, 0.12)
        g.fillRect(x, y, TILE_SIZE, TILE_SIZE)
        g.lineStyle(1, 0xffffff, 0.25)
        g.strokeRect(x, y, TILE_SIZE, TILE_SIZE)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Input
  // ═══════════════════════════════════════════════════════════════

  /** Check if a furniture item occupies the given tile */
  private findFurnitureAtTileLocal(
    col: number,
    row: number
  ): { uid: string; col: number; row: number } | null {
    if (!this.officeState) return null
    const layout = this.officeState.getLayout()
    return findFurnitureAtTile(layout.furniture, col, row) ?? null
  }

  /** Update canvas cursor based on active tool and context */
  private updateCursor(): void {
    if (!this.editorState) return
    const canvas = this.input.manager.canvas
    if (this.editorState.activeTool === EditTool.SELECT) {
      canvas.style.cursor = 'grab'
    } else {
      canvas.style.cursor = 'crosshair'
    }
  }

  // setupInputHandlers has been extracted into editor/input/EditorInputHandler.ts
  // and is called via setupEditorInput() in create().

  // ═══════════════════════════════════════════════════════════════
  // Private: Furniture rendering
  // ═══════════════════════════════════════════════════════════════

  private createFurniture(): void {
    clearFurnitureSprites(this.furnitureSprites)
    const office = this.officeState
    if (!office) return

    const instances = office.furniture
    this.lastFurnitureRef = instances

    this.furnitureSprites = createFurnitureSpritesShared(
      this,
      instances as FurnitureInstance[],
      this.furnitureTextureCache,
      this.furnitureTexCounterObj,
      'editor-furn',
      registerSpriteDataTexture,
      true
    )
  }

  private clearFurniture(): void {
    clearFurnitureSprites(this.furnitureSprites)
  }

  private updateFurniture(): void {
    const office = this.officeState
    if (!office) return

    const instances = office.furniture
    if (instances === this.lastFurnitureRef) return

    this.createFurniture()
  }

  // ═══════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════

  shutdown(): void {
    this.clearFurniture()
    this.floorGraphics?.destroy()
    this.gridGraphics?.destroy()
    this.selectionGraphics?.destroy()
    this.ghostGraphics?.destroy()
    this.furnitureTextureCache.clear()
    this.officeState = null
    this.editorState = null
  }
}

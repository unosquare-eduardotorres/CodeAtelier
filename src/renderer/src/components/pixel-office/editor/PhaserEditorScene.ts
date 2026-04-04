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
import type { FloorColor, OfficeLayout, SpriteData, FurnitureInstance } from '../engine/types'
import { TILE_SIZE, TileType } from '../engine/types'
import { deserializeLayout } from '../layout/layoutSerializer'
import { getCatalogEntry } from '../layout/furnitureCatalog'
import { registerSpriteDataTexture } from '../phaser/PhaserSpriteLoader'
import type { EditorState } from './editorState'
import { EditTool } from '../engine/types'
import { canPlaceFurniture, getWallPlacementRow } from './editorActions'
// Constants imported from local module
import defaultLayoutJson from '@renderer/assets/pixel-office/default-layout.json'

// Procedural wall and floor colors matching PhaserOfficeScene — Code Atelier Renaissance palette
const WALL_BASE_COLOR = 0x0f1517 // --ca-bg-primary deep obsidian stone
const WALL_ACCENT_COLOR = 0x283337 // --ca-panel-navy mortar lines
const BASEBOARD_COLOR = 0x8b6f4a // --ca-gold-muted baseboard trim

// Warm wood plank palette
const PLANK_COLORS = [0x5c3a1e, 0x6b4226, 0x4e3018, 0x7a5030, 0x5a3820]

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
interface EditorSceneCallbacks {
  onTileAction?: (col: number, row: number) => void
  onEraseAction?: (col: number, row: number) => void
  onSelectionChange?: () => void
  onDragMove?: (uid: string, newCol: number, newRow: number) => void
}

export class PhaserEditorScene extends Phaser.Scene {
  private officeState: OfficeState | null = null
  private pendingLayout: OfficeLayout | null = null
  private editorState: EditorState | null = null
  private callbacks: EditorSceneCallbacks = {}

  // Graphics layers
  private floorGraphics: Phaser.GameObjects.Graphics | null = null
  private gridGraphics: Phaser.GameObjects.Graphics | null = null
  private selectionGraphics: Phaser.GameObjects.Graphics | null = null
  private ghostGraphics: Phaser.GameObjects.Graphics | null = null

  // Furniture sprites
  private furnitureSprites: Phaser.GameObjects.Image[] = []
  private furnitureTextureCache = new Map<SpriteData, string>()
  private furnitureTexCounter = 0
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

  setCallbacks(callbacks: EditorSceneCallbacks): void {
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
      this.pendingLayout ||
      deserializeLayout(JSON.stringify(defaultLayoutJson)) ||
      undefined
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
    this.setupInputHandlers()
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

    // Floor tiles
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = tileMap[r][c]
        if (tile === TileType.VOID || tile === TileType.WALL) continue

        const x = c * TILE_SIZE
        const y = r * TILE_SIZE

        const colorIdx = r * layout.cols + c
        const floorColor = layout.tileColors?.[colorIdx]
        const baseColor = floorColor
          ? this.floorColorToHex(floorColor)
          : PLANK_COLORS[r % PLANK_COLORS.length]

        g.fillStyle(baseColor, 1)
        g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

        g.lineStyle(1, 0x2a1a0a, 0.15)
        g.lineBetween(x, y, x + TILE_SIZE, y)
      }
    }

    // Walls
    this.drawWalls(g, tileMap, rows, cols)
  }

  private drawWalls(
    g: Phaser.GameObjects.Graphics,
    tileMap: number[][],
    rows: number,
    cols: number
  ): void {
    const isFloor = (r: number, c: number): boolean =>
      r >= 0 &&
      r < rows &&
      c >= 0 &&
      c < cols &&
      tileMap[r][c] !== TileType.WALL &&
      tileMap[r][c] !== TileType.VOID

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r][c] !== TileType.WALL) continue

        const x = c * TILE_SIZE
        const y = r * TILE_SIZE

        g.fillStyle(WALL_BASE_COLOR, 1)
        g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

        g.lineStyle(1, WALL_ACCENT_COLOR, 0.3)
        for (let my = 4; my < TILE_SIZE; my += 4) {
          g.lineBetween(x, y + my, x + TILE_SIZE, y + my)
        }
        const vOffset = (r % 2) * (TILE_SIZE / 2)
        for (let mx = vOffset; mx < TILE_SIZE; mx += TILE_SIZE) {
          g.lineStyle(1, WALL_ACCENT_COLOR, 0.2)
          g.lineBetween(x + (mx % TILE_SIZE), y, x + (mx % TILE_SIZE), y + TILE_SIZE)
        }
        g.lineStyle(1, WALL_ACCENT_COLOR, 0.5)
        g.lineBetween(x, y, x, y + TILE_SIZE)

        const hasFloorBelow = isFloor(r + 1, c)
        const hasFloorAbove = isFloor(r - 1, c)
        const hasFloorLeft = isFloor(r, c - 1)
        const hasFloorRight = isFloor(r, c + 1)

        if (hasFloorBelow) {
          g.fillStyle(BASEBOARD_COLOR, 1)
          g.fillRect(x, y + TILE_SIZE - 3, TILE_SIZE, 3)
        }
        if (hasFloorAbove) {
          g.fillStyle(BASEBOARD_COLOR, 1)
          g.fillRect(x, y, TILE_SIZE, 3)
        }
        if (hasFloorLeft) {
          g.fillStyle(BASEBOARD_COLOR, 1)
          g.fillRect(x, y, 3, TILE_SIZE)
        }
        if (hasFloorRight) {
          g.fillStyle(BASEBOARD_COLOR, 1)
          g.fillRect(x + TILE_SIZE - 3, y, 3, TILE_SIZE)
        }
      }
    }
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
  private findFurnitureAtTile(
    col: number,
    row: number
  ): { uid: string; col: number; row: number } | null {
    if (!this.officeState) return null
    const layout = this.officeState.getLayout()
    for (const f of layout.furniture) {
      const entry = getCatalogEntry(f.type)
      if (!entry) continue
      if (
        col >= f.col &&
        col < f.col + entry.footprintW &&
        row >= f.row &&
        row < f.row + entry.footprintH
      ) {
        return f
      }
    }
    return null
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

  private setupInputHandlers(): void {
    let cameraDragging = false
    let lastPointerX = 0
    let lastPointerY = 0
    let spaceDown = false
    let dragStartPointerX = 0
    let dragStartPointerY = 0
    const DRAG_THRESHOLD = 2

    // Track Space key for camera pan in any tool
    this.input.keyboard?.on('keydown-SPACE', () => {
      spaceDown = true
      this.input.manager.canvas.style.cursor = 'grab'
    })
    this.input.keyboard?.on('keyup-SPACE', () => {
      spaceDown = false
      this.updateCursor()
    })

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.editorState || !this.officeState) return

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
      const col = Math.floor(worldPoint.x / TILE_SIZE)
      const row = Math.floor(worldPoint.y / TILE_SIZE)

      // Right-click OR Ctrl+Left-click: erase (macOS right-click alternative)
      if (
        pointer.rightButtonDown() ||
        (pointer.leftButtonDown() && pointer.event.ctrlKey)
      ) {
        this.callbacks.onEraseAction?.(col, row)
        this.isDragging = true
        return
      }

      // Middle-click: camera pan
      if (pointer.middleButtonDown()) {
        cameraDragging = true
        lastPointerX = pointer.x
        lastPointerY = pointer.y
        this.input.manager.canvas.style.cursor = 'grabbing'
        return
      }

      // Space + left-click: camera pan (any tool)
      if (pointer.leftButtonDown() && spaceDown) {
        cameraDragging = true
        lastPointerX = pointer.x
        lastPointerY = pointer.y
        this.input.manager.canvas.style.cursor = 'grabbing'
        return
      }

      // Left-click: tool-dependent action
      if (pointer.leftButtonDown()) {
        const es = this.editorState

        if (es.activeTool === EditTool.SELECT) {
          // SELECT mode: check for furniture hit → start drag-move or select
          const hit = this.findFurnitureAtTile(col, row)
          if (hit) {
            // Select the furniture and start drag tracking
            es.selectedFurnitureUid = hit.uid
            es.startDrag(hit.uid, hit.col, hit.row, col - hit.col, row - hit.row)
            dragStartPointerX = pointer.x
            dragStartPointerY = pointer.y
            this.input.manager.canvas.style.cursor = 'move'
            this.callbacks.onSelectionChange?.()
          } else {
            // No furniture hit → camera pan
            es.selectedFurnitureUid = null
            cameraDragging = true
            lastPointerX = pointer.x
            lastPointerY = pointer.y
            this.input.manager.canvas.style.cursor = 'grabbing'
            this.callbacks.onSelectionChange?.()
          }
          return
        }

        // Non-SELECT tools: fire tile action and start drag painting
        this.callbacks.onTileAction?.(col, row)
        es.isDragging = true
        this.isDragging = true

        // Reset wallDragAdding on new click for wall paint
        if (es.activeTool === EditTool.WALL_PAINT) {
          es.wallDragAdding = null
        }
      }
    })

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.editorState || !this.officeState) return

      // Camera pan
      if (cameraDragging) {
        const cam = this.cameras.main
        const dx = (lastPointerX - pointer.x) / cam.zoom
        const dy = (lastPointerY - pointer.y) / cam.zoom
        cam.scrollX += dx
        cam.scrollY += dy
        lastPointerX = pointer.x
        lastPointerY = pointer.y
        return
      }

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
      const col = Math.floor(worldPoint.x / TILE_SIZE)
      const row = Math.floor(worldPoint.y / TILE_SIZE)

      // Update ghost position
      this.editorState.ghostCol = col
      this.editorState.ghostRow = row

      // Furniture drag-move in SELECT mode
      const es = this.editorState
      if (es.dragUid && pointer.leftButtonDown()) {
        const dist = Math.sqrt(
          (pointer.x - dragStartPointerX) ** 2 + (pointer.y - dragStartPointerY) ** 2
        )
        if (dist > DRAG_THRESHOLD) {
          es.isDragMoving = true
          const newCol = col - es.dragOffsetCol
          const newRow = row - es.dragOffsetRow
          this.callbacks.onDragMove?.(es.dragUid, newCol, newRow)
        }
        return
      }

      // Drag painting for floor/wall/erase
      if (this.isDragging && pointer.leftButtonDown()) {
        const tool = es.activeTool
        if (
          tool === EditTool.TILE_PAINT ||
          tool === EditTool.WALL_PAINT ||
          tool === EditTool.ERASE
        ) {
          this.callbacks.onTileAction?.(col, row)
        }
      }

      // Drag erasing with right button or Ctrl+left
      if (
        this.isDragging &&
        (pointer.rightButtonDown() ||
          (pointer.leftButtonDown() && pointer.event.ctrlKey))
      ) {
        this.callbacks.onEraseAction?.(col, row)
      }
    })

    this.input.on('pointerup', () => {
      if (cameraDragging) {
        cameraDragging = false
        this.updateCursor()
      }

      // Finalize furniture drag-move
      if (this.editorState?.dragUid) {
        this.editorState.clearDrag()
        this.updateCursor()
      }

      this.isDragging = false
      if (this.editorState) {
        this.editorState.isDragging = false
        this.editorState.wallDragAdding = null
      }
    })

    // Scroll → camera pan (no zoom) — two-finger trackpad scrolls the viewport
    this.input.on(
      'wheel',
      (_pointer: Phaser.Input.Pointer, _gos: unknown, dx: number, dy: number) => {
        const cam = this.cameras.main
        cam.scrollX += dx / cam.zoom
        cam.scrollY += dy / cam.zoom
      }
    )

    // Disable context menu
    this.input.mouse?.disableContextMenu()
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Furniture rendering
  // ═══════════════════════════════════════════════════════════════

  private getFurnitureTextureKey(sprite: SpriteData): string {
    const cached = this.furnitureTextureCache.get(sprite)
    if (cached) return cached

    const key = `editor-furn-${this.furnitureTexCounter++}`
    registerSpriteDataTexture(this, key, sprite)
    this.furnitureTextureCache.set(sprite, key)
    return key
  }

  private createFurniture(): void {
    this.clearFurniture()
    const office = this.officeState
    if (!office) return

    const instances = office.furniture
    this.lastFurnitureRef = instances

    for (const inst of instances) {
      const key = this.getFurnitureTextureKey(inst.sprite)
      const spriteH = inst.sprite.length
      const spriteW = inst.sprite[0]?.length ?? 0
      const img = this.add.image(inst.x + spriteW / 2, inst.y + spriteH / 2, key)
      img.setDepth(inst.zY)
      if (inst.mirrored) img.setFlipX(true)
      this.furnitureSprites.push(img)
    }
  }

  private clearFurniture(): void {
    for (const s of this.furnitureSprites) s.destroy()
    this.furnitureSprites = []
  }

  private updateFurniture(): void {
    const office = this.officeState
    if (!office) return

    const instances = office.furniture
    if (instances === this.lastFurnitureRef) return

    this.createFurniture()
  }

  private floorColorToHex(color: FloorColor): number {
    const h = ((color.h % 360) + 360) % 360
    const l = Math.max(0.06, Math.min(0.55, 0.25 + color.b / 150))
    const s = Math.max(0.08, Math.min(0.5, 0.25 + color.s / 200))

    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2

    let r1 = 0,
      g1 = 0,
      b1 = 0
    if (h < 60) {
      r1 = c; g1 = x; b1 = 0
    } else if (h < 120) {
      r1 = x; g1 = c; b1 = 0
    } else if (h < 180) {
      r1 = 0; g1 = c; b1 = x
    } else if (h < 240) {
      r1 = 0; g1 = x; b1 = c
    } else if (h < 300) {
      r1 = x; g1 = 0; b1 = c
    } else {
      r1 = c; g1 = 0; b1 = x
    }

    const ri = Math.round((r1 + m) * 255)
    const gi = Math.round((g1 + m) * 255)
    const bi = Math.round((b1 + m) * 255)
    return (ri << 16) | (gi << 8) | bi
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

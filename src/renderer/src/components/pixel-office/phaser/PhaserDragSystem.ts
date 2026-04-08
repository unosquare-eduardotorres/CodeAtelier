/**
 * PhaserDragSystem — Drag-and-drop for agents and furniture in the Phaser scene.
 *
 * Uses Phaser's native drag system with grid snapping.
 * Provides visual feedback during drag (grid overlay, snap preview).
 */

import Phaser from 'phaser'

import { TILE_SIZE } from '../engine/types'

// ── Types ──

export interface DragCallbacks {
  /** Called when an agent is dropped on a new tile */
  onAgentDrop?: (numericId: number, col: number, row: number) => void
  /** Called when furniture is dropped on a new tile */
  onFurnitureDrop?: (uid: string, col: number, row: number) => void
  /** Called when an agent is clicked (not dragged) */
  onAgentClick?: (numericId: number) => void
}

// ── Grid overlay ──

const GRID_LINE_COLOR = 0xffffff
const GRID_LINE_ALPHA = 0.12
const SNAP_HIGHLIGHT_COLOR = 0x3b82f6
const SNAP_HIGHLIGHT_ALPHA = 0.3

/**
 * PhaserDragSystem — Sets up interactive drag-and-drop within the Phaser scene.
 */
export class PhaserDragSystem {
  private scene: Phaser.Scene
  private callbacks: DragCallbacks
  private gridOverlay: Phaser.GameObjects.Graphics | null = null
  private snapHighlight: Phaser.GameObjects.Rectangle | null = null
  private isDragging = false
  private dragStartPos = { x: 0, y: 0 }
  private cols = 0
  private rows = 0

  constructor(scene: Phaser.Scene, callbacks: DragCallbacks) {
    this.scene = scene
    this.callbacks = callbacks
  }

  /**
   * Initialize the drag system. Call after scene.create().
   */
  setup(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows

    // Create grid overlay (hidden by default)
    this.gridOverlay = this.scene.add.graphics()
    this.gridOverlay.setVisible(false)
    this.gridOverlay.setDepth(1000)

    // Create snap highlight (hidden by default)
    this.snapHighlight = this.scene.add.rectangle(
      0,
      0,
      TILE_SIZE,
      TILE_SIZE,
      SNAP_HIGHLIGHT_COLOR,
      SNAP_HIGHLIGHT_ALPHA
    )
    this.snapHighlight.setOrigin(0, 0)
    this.snapHighlight.setVisible(false)
    this.snapHighlight.setDepth(999)

    // Set up drag event listeners
    this.scene.input.on('dragstart', this.onDragStart, this)
    this.scene.input.on('drag', this.onDrag, this)
    this.scene.input.on('dragend', this.onDragEnd, this)
  }

  /**
   * Make a game object draggable.
   */
  enableDrag(gameObject: Phaser.GameObjects.Container): void {
    gameObject.setInteractive(
      new Phaser.Geom.Rectangle(-TILE_SIZE / 2, -TILE_SIZE * 1.5, TILE_SIZE, TILE_SIZE * 2),
      Phaser.Geom.Rectangle.Contains
    )
    this.scene.input.setDraggable(gameObject)
  }

  /**
   * Make a game object clickable only (no drag).
   */
  enableClick(gameObject: Phaser.GameObjects.Container): void {
    gameObject.setInteractive(
      new Phaser.Geom.Rectangle(-TILE_SIZE / 2, -TILE_SIZE * 1.5, TILE_SIZE, TILE_SIZE * 2),
      Phaser.Geom.Rectangle.Contains
    )

    gameObject.on('pointerup', () => {
      if (this.isDragging) return
      const type = gameObject.getData('type')
      if (type === 'agent') {
        const numericId = gameObject.getData('numericId')
        this.callbacks.onAgentClick?.(numericId)
      }
    })
  }

  // ── Event handlers ──

  private onDragStart(
    _pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.Container
  ): void {
    this.isDragging = true
    this.dragStartPos = { x: gameObject.x, y: gameObject.y }

    // Show grid overlay
    this.drawGrid()
    this.gridOverlay?.setVisible(true)

    // Bring dragged object to top
    gameObject.setDepth(2000)
  }

  private onDrag(
    _pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.Container,
    dragX: number,
    dragY: number
  ): void {
    gameObject.setPosition(dragX, dragY)

    // Show snap preview
    const { col, row } = this.worldToTile(dragX, dragY)
    if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
      this.snapHighlight?.setPosition(col * TILE_SIZE, row * TILE_SIZE)
      this.snapHighlight?.setVisible(true)
    } else {
      this.snapHighlight?.setVisible(false)
    }
  }

  private onDragEnd(
    _pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.Container
  ): void {
    this.isDragging = false

    // Hide overlays
    this.gridOverlay?.setVisible(false)
    this.snapHighlight?.setVisible(false)

    // Snap to grid
    const { col, row } = this.worldToTile(gameObject.x, gameObject.y)

    if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
      // Valid position — snap to tile center
      const snapX = col * TILE_SIZE + TILE_SIZE / 2
      const snapY = row * TILE_SIZE + TILE_SIZE / 2

      this.scene.tweens.add({
        targets: gameObject,
        x: snapX,
        y: snapY,
        duration: 100,
        ease: 'Power2'
      })

      // Emit callback
      const type = gameObject.getData('type')
      if (type === 'agent') {
        const numericId = gameObject.getData('numericId')
        this.callbacks.onAgentDrop?.(numericId, col, row)
      } else if (type === 'furniture') {
        const uid = gameObject.getData('uid')
        this.callbacks.onFurnitureDrop?.(uid, col, row)
      }
    } else {
      // Invalid position — snap back
      this.scene.tweens.add({
        targets: gameObject,
        x: this.dragStartPos.x,
        y: this.dragStartPos.y,
        duration: 200,
        ease: 'Power2'
      })
    }

    // Reset depth
    gameObject.setDepth(gameObject.y + 0.5)
  }

  // ── Helpers ──

  private worldToTile(x: number, y: number): { col: number; row: number } {
    return {
      col: Math.floor(x / TILE_SIZE),
      row: Math.floor(y / TILE_SIZE)
    }
  }

  private drawGrid(): void {
    if (!this.gridOverlay) return
    this.gridOverlay.clear()
    this.gridOverlay.lineStyle(1, GRID_LINE_COLOR, GRID_LINE_ALPHA)

    // Vertical lines
    for (let c = 0; c <= this.cols; c++) {
      this.gridOverlay.lineBetween(c * TILE_SIZE, 0, c * TILE_SIZE, this.rows * TILE_SIZE)
    }

    // Horizontal lines
    for (let r = 0; r <= this.rows; r++) {
      this.gridOverlay.lineBetween(0, r * TILE_SIZE, this.cols * TILE_SIZE, r * TILE_SIZE)
    }
  }

  /**
   * Update grid dimensions (e.g., after layout change).
   */
  updateDimensions(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  /**
   * Clean up all drag system resources.
   */
  destroy(): void {
    this.scene.input.off('dragstart', this.onDragStart, this)
    this.scene.input.off('drag', this.onDrag, this)
    this.scene.input.off('dragend', this.onDragEnd, this)

    this.gridOverlay?.destroy()
    this.snapHighlight?.destroy()
    this.gridOverlay = null
    this.snapHighlight = null
  }
}

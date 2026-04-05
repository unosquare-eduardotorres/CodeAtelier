/**
 * PhaserOfficeScene — Main Phaser.Scene that replaces the custom Canvas 2D engine.
 *
 * Renders the office floor, walls, furniture, and agents using Phaser 3's
 * WebGL/Canvas renderer. Keeps OfficeState as the authoritative data model
 * and reads from it each frame, using Phaser only for rendering and animation.
 *
 * Uses procedural rendering for floor and walls (Graphics API) and cached
 * textures for furniture — matching the Outworked pattern for performance.
 *
 * Replaces: engine/renderer.ts, engine/gameLoop.ts, engine/characters.ts (rendering parts)
 * Preserves: OfficeState (state management), tileMap.ts (A* pathfinding), layoutSerializer.ts
 */

import Phaser from 'phaser'

import type { OfficeLayout, FloorColor, FurnitureInstance, SpriteData, Character } from '../engine/types'
import { TileType, TILE_SIZE } from '../engine/types'
import { OfficeState } from '../engine/officeState'
import { deserializeLayout } from '../layout'
import { loadAllAssets } from '../assetLoader'
import {
  createCharacterTextures,
  createBubbleTextures,
  registerSpriteDataTexture
} from './PhaserSpriteLoader'
import { loadAndSwapRpgTexture } from './RpgTextureLoader'
import { PhaserAgentManager } from './PhaserAgentManager'
// SPRITE_ASSIGNMENTS and DEFAULT_SEAT_ASSIGNMENTS are now used internally by PlaceholderManager
import { PhaserDragSystem } from './PhaserDragSystem'
import { DustParticleSystem } from './DustParticleSystem'
import { PlaceholderManager, AGENT_NAMES } from './PlaceholderManager'
import {
  drawWalls as drawWallsShared,
  drawFloorTiles,
  createFurnitureSprites as createFurnitureSpritesShared,
  clearFurnitureSprites
} from './renderUtils'
import { MAX_DELTA_TIME_SEC } from '../constants'

import defaultLayoutJson from '@renderer/assets/pixel-office/default-layout.json'

// Vite glob import for RPG sprite PNGs
const rpgSpriteModules = import.meta.glob<string>(
  '@renderer/assets/pixel-office/sprites/**/*.png',
  { eager: true, import: 'default' }
)

/** Resolve a sprite catalog src path to an actual Vite-resolved URL */
function resolveRpgSpriteSrc(relativeSrc: string): string | undefined {
  const rel = relativeSrc.replace('./', '')
  for (const [key, url] of Object.entries(rpgSpriteModules)) {
    if (key.endsWith(rel)) return url
  }
  return undefined
}

// ── Types ──

export interface SceneCallbacks {
  onAgentClick?: (numericId: number) => void
  onFurnitureDrop?: (uid: string, col: number, row: number) => void
}

export interface SceneInitData {
  layout?: OfficeLayout | null
  callbacks?: SceneCallbacks
}

// Renaissance palette constants imported from ./renderUtils

/**
 * PhaserOfficeScene — Phaser.Scene that renders the pixel office.
 */
export class PhaserOfficeScene extends Phaser.Scene {
  // Core state
  private officeState: OfficeState | null = null
  private initData: SceneInitData = {}

  // Pre-init layout (set from React before Phaser calls create())
  private pendingLayout: OfficeLayout | null = null

  // Sub-systems
  private agentManager: PhaserAgentManager | null = null
  private dragSystem: PhaserDragSystem | null = null
  private readonly dustSystem = new DustParticleSystem()
  private readonly placeholderMgr = new PlaceholderManager()

  // Phaser rendering objects
  private floorGraphics: Phaser.GameObjects.Graphics | null = null
  private furnitureSprites: Phaser.GameObjects.Image[] = []

  // Furniture texture cache — keyed by SpriteData reference
  private furnitureTextureCache = new Map<SpriteData, string>()

  // Track furniture array reference to avoid unnecessary rebuilds
  private lastFurnitureRef: readonly import('../engine/types').FurnitureInstance[] | null = null

  // Track if assets are loaded
  private assetsLoaded = false

  constructor() {
    super({ key: 'PhaserOfficeScene' })
  }

  // ═══════════════════════════════════════════════════════════════
  // Pre-init API (called from React before Phaser starts)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Set the office layout before Phaser calls create().
   * React calls this immediately after constructing the scene instance.
   */
  setLayout(layout: OfficeLayout | null | undefined): void {
    this.pendingLayout = layout ?? null
  }

  init(data: SceneInitData): void {
    this.initData = data
  }

  preload(): void {
    // Assets are loaded asynchronously in create() using the existing asset loader
    // and runtime texture generation. No Phaser preload needed.
  }

  async create(): Promise<void> {
    // Load existing assets using the same pipeline as old engine
    await loadAllAssets()

    // Create character textures from loaded PNGs
    await createCharacterTextures(this)

    // Create bubble textures
    createBubbleTextures(this)

    this.assetsLoaded = true

    // Initialize office state — prefer pendingLayout (from React), then initData, then default
    const layout =
      this.pendingLayout ||
      this.initData.layout ||
      deserializeLayout(JSON.stringify(defaultLayoutJson)) ||
      undefined
    this.officeState = new OfficeState(layout)

    // Initialize sub-systems
    this.agentManager = new PhaserAgentManager(this)
    this.dragSystem = new PhaserDragSystem(this, {
      onAgentClick: this.initData.callbacks?.onAgentClick,
      onFurnitureDrop: (uid, col, row) => {
        this.initData.callbacks?.onFurnitureDrop?.(uid, col, row)
      },
      onAgentDrop: (numericId, col, row) => {
        // Reassign agent to nearest seat at drop position
        const office = this.officeState
        if (!office) return
        const seatId = office.getSeatAtTile(col, row)
        if (seatId) {
          office.reassignSeat(numericId, seatId)
        }
      }
    })

    const layoutData = this.officeState.getLayout()
    this.dragSystem.setup(layoutData.cols, layoutData.rows)

    // Render the static office elements (procedural floor + walls)
    this.drawOffice()

    // Create furniture textures once and add sprites
    this.createFurniture()

    // Initialize dust particles (extracted system)
    this.dustSystem.init(this, this.officeState.getLayout())

    // Populate idle placeholder agents (gives life to the office at rest)
    this.populatePlaceholders()

    // Center camera on the office (no bounds — let RESIZE mode handle viewport)
    const worldW = layoutData.cols * TILE_SIZE
    const worldH = layoutData.rows * TILE_SIZE
    this.cameras.main.centerOn(worldW / 2, worldH / 2)

    // ── Camera drag-to-pan ──
    // Track drag state for hand-panning the camera (only when not dragging agents/furniture)
    let cameraDragging = false
    let lastPointerX = 0
    let lastPointerY = 0

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // Only start camera pan if not clicking an interactive object
      const hitObjects = this.input.hitTestPointer(pointer)
      if (hitObjects.length === 0) {
        cameraDragging = true
        lastPointerX = pointer.x
        lastPointerY = pointer.y
        this.input.manager.canvas.style.cursor = 'grabbing'
      }
    })

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!cameraDragging) return
      const cam = this.cameras.main
      const dx = (lastPointerX - pointer.x) / cam.zoom
      const dy = (lastPointerY - pointer.y) / cam.zoom
      cam.scrollX += dx
      cam.scrollY += dy
      lastPointerX = pointer.x
      lastPointerY = pointer.y
    })

    this.input.on('pointerup', () => {
      if (cameraDragging) {
        cameraDragging = false
        this.input.manager.canvas.style.cursor = 'grab'
      }
    })

    // Set initial cursor
    this.input.manager.canvas.style.cursor = 'grab'

    // Disable scroll wheel zoom on the Phaser canvas
    this.input.mouse?.disableContextMenu()

    // Signal that the scene is fully initialized (assets loaded, placeholders populated).
    // PhaserOfficeCanvas listens for this instead of the Phaser 'create' event, which
    // fires before this async method completes.
    this.events.emit('office-ready')
  }

  update(_time: number, deltaMs: number): void {
    if (!this.officeState || !this.agentManager || !this.assetsLoaded) return

    // Convert to seconds and cap
    const dt = Math.min(deltaMs / 1000, MAX_DELTA_TIME_SEC)

    // Update game logic (OfficeState handles FSM, wandering, paths, etc.)
    this.officeState.update(dt)

    // Sync Phaser visuals from OfficeState
    this.syncAgentVisuals()

    // Update furniture (only if array reference changed)
    this.updateFurniture()

    // Update dust particles (extracted system)
    this.dustSystem.update(dt, this.officeState?.getLayout())
  }

  // ═══════════════════════════════════════════════════════════════
  // Public API (called from React bridge via PhaserOfficeCanvas)
  // ═══════════════════════════════════════════════════════════════

  getOfficeState(): OfficeState | null {
    return this.officeState
  }

  addAgent(
    numericId: number,
    spriteIndex: number,
    hueShift: number,
    seatIndex?: number,
    displayName?: string,
    pixelSpriteId?: string
  ): void {
    const office = this.officeState
    if (!office || !this.agentManager) return

    office.addAgent(numericId, spriteIndex, hueShift)
    this.assignAgentSeat(office, numericId, seatIndex)

    const ch = office.characters.get(numericId)
    if (!ch) return

    if (displayName) ch.displayName = displayName
    this.spawnInIdleZone(office, ch)

    if (pixelSpriteId && this.agentManager) {
      loadAndSwapRpgTexture(this, pixelSpriteId, this.agentManager, numericId, resolveRpgSpriteSrc)
    }

    this.agentManager.createAgent(numericId, spriteIndex, hueShift, ch.x, ch.y, displayName)
    this.agentManager.playSpawnAnimation(numericId)
  }

  /** Assign an agent to a specific seat by index, if valid. */
  private assignAgentSeat(office: OfficeState, numericId: number, seatIndex?: number): void {
    if (seatIndex === undefined) return
    const seatEntries = Array.from(office.seats.values())
    if (seatIndex < seatEntries.length) {
      office.reassignSeat(numericId, seatEntries[seatIndex].uid)
    }
  }

  /** Spawn a character at a random idle zone tile, if any exist. */
  private spawnInIdleZone(office: OfficeState, ch: Character): void {
    const idleZone = office.idleZoneTiles
    if (idleZone.length === 0) return
    const spot = idleZone[Math.floor(Math.random() * idleZone.length)]
    ch.x = spot.col * TILE_SIZE + TILE_SIZE / 2
    ch.y = spot.row * TILE_SIZE + TILE_SIZE / 2
    ch.tileCol = spot.col
    ch.tileRow = spot.row
  }

  removeAgent(numericId: number): void {
    if (!this.officeState || !this.agentManager) return
    this.officeState.removeAgent(numericId)
    this.agentManager.removeAgent(numericId, true)
  }

  setAgentActive(numericId: number, active: boolean): void {
    if (!this.officeState) return
    this.officeState.setAgentActive(numericId, active)
  }

  setAgentTool(numericId: number, tool: string | null): void {
    if (!this.officeState) return
    this.officeState.setAgentTool(numericId, tool)
  }

  showPermissionBubble(numericId: number): void {
    if (!this.officeState || !this.agentManager) return
    this.officeState.showPermissionBubble(numericId)
    this.agentManager.showBubble(numericId, 'permission')
  }

  clearPermissionBubble(numericId: number): void {
    if (!this.officeState || !this.agentManager) return
    this.officeState.clearPermissionBubble(numericId)
    this.agentManager.clearBubble(numericId)
  }

  getTotalSeats(): number {
    return this.officeState?.seats.size ?? 0
  }

  /**
   * Get the placeholder (idle) numeric ID for an agent type, if one exists.
   */
  getPlaceholderNumericId(agentType: string): number | undefined {
    return this.placeholderMgr.getNumericId(agentType)
  }

  /**
   * Remove a placeholder agent to make room for a real (active) agent session.
   */
  removePlaceholder(agentType: string): void {
    this.placeholderMgr.remove(agentType, this.officeState, this.agentManager)
  }

  /**
   * Restore a placeholder idle agent when a real agent session ends.
   */
  restorePlaceholder(agentType: string): void {
    const info = this.placeholderMgr.restore(agentType)
    if (!info) return
    this.addAgent(info.numericId, info.spriteIndex, info.hueShift, info.seatIdx, info.displayName)
  }

  /**
   * Set the thought/activity text bubble for an agent.
   */
  setAgentThought(numericId: number, thought: string | null): void {
    if (!this.officeState) return
    this.officeState.setAgentThought(numericId, thought)
  }

  updateAgentDisplayName(numericId: number, name: string): void {
    this.agentManager?.updateDisplayName(numericId, name)
    const ch = this.officeState?.characters.get(numericId)
    if (ch) ch.displayName = name
  }

  // ─── Placeholder agent population ───

  /**
   * Populate idle placeholder agents using the extracted PlaceholderManager.
   * Delegates population logic while keeping RPG texture loading in the scene.
   */
  private populatePlaceholders(): void {
    const office = this.officeState
    if (!office || !this.agentManager) return

    this.placeholderMgr.populate(office, this.agentManager, (spriteId, numericId) => {
      if (this.agentManager) {
        loadAndSwapRpgTexture(this, spriteId, this.agentManager, numericId, resolveRpgSpriteSrc)
      }
    })
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Office rendering (procedural — Outworked pattern)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Draw the entire office using procedural Graphics API.
   * Floor tiles get warm wood-plank colors; walls get solid dark fills
   * with baseboard accents on edges adjacent to floor tiles.
   */
  private drawOffice(): void {
    const office = this.officeState
    if (!office) return

    const layout = office.getLayout()
    const tileMap = office.tileMap

    // Create graphics layer for floor and walls
    const g = this.add.graphics()
    this.floorGraphics = g
    g.setDepth(-1)

    const rows = tileMap.length
    const cols = rows > 0 ? tileMap[0].length : 0

    // ── Pass 1: Draw floor tiles (shared) ──
    drawFloorTiles(g, tileMap, layout)

    // ── Pass 2: Draw walls procedurally ──
    drawWallsShared(g, tileMap, rows, cols)
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Furniture rendering (cached textures)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get or create a cached Phaser texture key for a SpriteData.
   * Textures are created once and reused by reference identity.
   */
  private readonly furnitureTexCounterObj = { value: 0 }

  private createFurniture(): void {
    clearFurnitureSprites(this.furnitureSprites)
    const office = this.officeState
    if (!office) return

    this.furnitureSprites = createFurnitureSpritesShared(
      this,
      office.furniture as FurnitureInstance[],
      this.furnitureTextureCache,
      this.furnitureTexCounterObj,
      'furn',
      registerSpriteDataTexture,
      false
    )
    this.lastFurnitureRef = office.furniture
  }

  private clearFurniture(): void {
    clearFurnitureSprites(this.furnitureSprites)
  }

  /**
   * Update furniture sprites only when the furniture array reference changes.
   * Avoids recreating textures every frame (the old bug).
   */
  private updateFurniture(): void {
    const office = this.officeState
    if (!office) return

    const newFurniture = office.furniture
    if (this.lastFurnitureRef === newFurniture) return
    this.lastFurnitureRef = newFurniture

    clearFurnitureSprites(this.furnitureSprites)
    this.furnitureSprites = createFurnitureSpritesShared(
      this,
      newFurniture as FurnitureInstance[],
      this.furnitureTextureCache,
      this.furnitureTexCounterObj,
      'furn',
      registerSpriteDataTexture,
      false
    )
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Agent population and sync
  // ═══════════════════════════════════════════════════════════════

  private syncAgentVisuals(): void {
    const office = this.officeState
    if (!office || !this.agentManager) return

    // Sync all agent positions and animations from OfficeState
    this.agentManager.syncFromCharacters(office.characters)

    // Handle agents that finished despawning (removed from OfficeState)
    for (const [id] of this.agentManager.getAgents()) {
      if (!office.characters.has(id)) {
        this.agentManager.removeAgent(id, false)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════

  shutdown(): void {
    this.agentManager?.destroyAll()
    this.dragSystem?.destroy()
    this.clearFurniture()
    this.furnitureTextureCache.clear()
    this.floorGraphics?.destroy()
    this.dustSystem.destroy()
  }
}

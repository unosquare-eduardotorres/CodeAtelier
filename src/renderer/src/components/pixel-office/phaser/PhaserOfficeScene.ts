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

import type { OfficeLayout, FloorColor, SpriteData } from '../engine/types'
import { TileType, TILE_SIZE } from '../engine/types'
import { OfficeState } from '../engine/officeState'
import { deserializeLayout } from '../layout'
import { loadAllAssets } from '../assetLoader'
import {
  createCharacterTextures,
  createRpgCharacterTexture,
  registerCharacterAnimations,
  createBubbleTextures,
  registerSpriteDataTexture
} from './PhaserSpriteLoader'
import { getSpriteById } from '@renderer/assets/pixel-office/sprites'
import { PhaserAgentManager } from './PhaserAgentManager'
import { SPRITE_ASSIGNMENTS, DEFAULT_SEAT_ASSIGNMENTS } from '../agentMapping'
import { PhaserDragSystem } from './PhaserDragSystem'
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

// ── Dark Renaissance stone castle palette ──
const PLANK_COLORS = [
  0x2e2420, // dark walnut
  0x3a2c24, // aged oak
  0x342820, // charred plank
  0x2a2018, // deep mahogany
  0x38302a // weathered timber
]
const WALL_BASE_COLOR = 0x1a1a2e // deep midnight stone
const WALL_ACCENT_COLOR = 0x2a2844 // dark purple-gray mortar
const BASEBOARD_COLOR = 0x6b5a3e // aged gold/bronze trim

// ── Agent display names (used for idle placeholder agents) ──
const AGENT_NAMES: Record<string, string> = {
  orchestrator: 'Orchestrator',
  generalist: 'Generalist',
  'react-architect': 'React Architect',
  'dotnet-architect': '.NET Architect',
  'electron-architect': 'Electron Architect',
  'agentic-architect': 'Agentic Architect',
  'db-architect': 'DB Architect',
  'ux-ui-specialist': 'UX/UI Specialist',
  'git-github-specialist': 'Git Specialist',
  'requirements-specialist': 'Requirements',
  'code-planner': 'Code Planner',
  'execution-planner': 'Exec Planner',
  'cicd-devops': 'CI/CD DevOps',
  'cloud-infrastructure': 'Cloud Infra'
}

/**
 * PhaserOfficeScene — Phaser.Scene that renders the pixel office.
 */
export class PhaserOfficeScene extends Phaser.Scene {
  // Core state
  private officeState: OfficeState | null = null
  private initData: SceneInitData = {}

  /** Tracks placeholder (idle) agent numericIds keyed by agentType */
  private placeholderAgents = new Map<string, number>()

  // Pre-init layout (set from React before Phaser calls create())
  private pendingLayout: OfficeLayout | null = null

  // Sub-systems
  private agentManager: PhaserAgentManager | null = null
  private dragSystem: PhaserDragSystem | null = null

  // Phaser rendering objects
  private floorGraphics: Phaser.GameObjects.Graphics | null = null
  private furnitureSprites: Phaser.GameObjects.Image[] = []
  private dustParticles: Phaser.GameObjects.Graphics | null = null

  // Furniture texture cache — keyed by SpriteData reference
  private furnitureTextureCache = new Map<SpriteData, string>()
  private furnitureTexCounter = 0

  // Track furniture array reference to avoid unnecessary rebuilds
  private lastFurnitureRef: readonly import('../engine/types').FurnitureInstance[] | null = null

  // Dust particle state
  private dustMotes: Array<{
    x: number
    y: number
    vx: number
    vy: number
    alpha: number
    life: number
    maxLife: number
  }> = []

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

    // Initialize dust particles
    this.initDustParticles()

    // Populate idle placeholder agents (gives life to the office at rest)
    this.populateAgents()

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

    // Update dust particles
    this.updateDustParticles(dt)
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

    const seatEntries = Array.from(office.seats.values())
    if (seatIndex !== undefined && seatIndex < seatEntries.length) {
      office.reassignSeat(numericId, seatEntries[seatIndex].uid)
    }

    const ch = office.characters.get(numericId)
    if (!ch) return

    // Set display name if provided
    if (displayName) ch.displayName = displayName

    // Spawn in idle zone if available
    const idleZone = office.idleZoneTiles
    if (idleZone.length > 0) {
      const spot = idleZone[Math.floor(Math.random() * idleZone.length)]
      ch.x = spot.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spot.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spot.col
      ch.tileRow = spot.row
    }

    // Try RPG sprite — load async and swap texture when ready
    if (pixelSpriteId) {
      const spriteEntry = getSpriteById(pixelSpriteId)
      if (spriteEntry) {
        const imageUrl = resolveRpgSpriteSrc(spriteEntry.src)
        if (imageUrl) {
          const texKey = `rpg-${pixelSpriteId}`
          createRpgCharacterTexture(this, imageUrl, texKey).then((key) => {
            const visual = this.agentManager?.getAgent(numericId)
            if (visual) {
              registerCharacterAnimations(this, key)
              visual.textureKey = key
              visual.sprite.setTexture(key, 1)
            }
          })
        }
      }
    }

    this.agentManager.createAgent(
      numericId,
      spriteIndex,
      hueShift,
      ch.x,
      ch.y,
      displayName
    )

    this.agentManager.playSpawnAnimation(numericId)
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
    return this.placeholderAgents.get(agentType)
  }

  /**
   * Remove a placeholder agent to make room for a real (active) agent session.
   */
  removePlaceholder(agentType: string): void {
    const numericId = this.placeholderAgents.get(agentType)
    if (numericId === undefined) return
    this.placeholderAgents.delete(agentType)
    if (!this.officeState || !this.agentManager) return
    // Remove without despawn animation — the real agent will replace it
    this.officeState.removeAgent(numericId)
    this.agentManager.removeAgent(numericId, false)
  }

  /**
   * Restore a placeholder idle agent when a real agent session ends.
   */
  restorePlaceholder(agentType: string): void {
    if (this.placeholderAgents.has(agentType)) return
    const assignment = SPRITE_ASSIGNMENTS[agentType]
    if (!assignment) return
    const seatIdx = DEFAULT_SEAT_ASSIGNMENTS[agentType]
    const numericId = this.nextPlaceholderId()
    this.placeholderAgents.set(agentType, numericId)
    this.addAgent(numericId, assignment.spriteIndex, assignment.hueShift, seatIdx, AGENT_NAMES[agentType])
  }

  /**
   * Set the thought/activity text bubble for an agent.
   */
  setAgentThought(numericId: number, thought: string | null): void {
    if (!this.officeState) return
    this.officeState.setAgentThought(numericId, thought)
  }

  // ─── Placeholder agent population ───

  private placeholderIdCounter = 50000

  private nextPlaceholderId(): number {
    return this.placeholderIdCounter++
  }

  /**
   * Populate all known agents as idle placeholders.
   * Only adds agents that the bridge hasn't already added.
   * Uses RPG sprites when available (pixelSpriteId), falls back to legacy char sheets.
   */
  private populateAgents(): void {
    const office = this.officeState
    if (!office || !this.agentManager) return

    const totalSeats = office.seats.size
    for (const [agentType, assignment] of Object.entries(SPRITE_ASSIGNMENTS)) {
      const seatIdx = DEFAULT_SEAT_ASSIGNMENTS[agentType]
      if (seatIdx !== undefined && seatIdx >= totalSeats) continue

      const numericId = this.nextPlaceholderId()
      this.placeholderAgents.set(agentType, numericId)

      office.addAgent(numericId, assignment.spriteIndex, assignment.hueShift, undefined, true)

      const seatEntries = Array.from(office.seats.values())
      if (seatIdx !== undefined && seatIdx < seatEntries.length) {
        office.reassignSeat(numericId, seatEntries[seatIdx].uid)
      }

      const ch = office.characters.get(numericId)
      if (!ch) continue
      ch.displayName = AGENT_NAMES[agentType]
      // Start placeholder agents as inactive (idle wandering)
      ch.isActive = false

      this.agentManager.createAgent(
        numericId,
        assignment.spriteIndex,
        assignment.hueShift,
        ch.x,
        ch.y,
        AGENT_NAMES[agentType]
      )

      // Load RPG sprite asynchronously and swap texture when ready
      if (assignment.pixelSpriteId) {
        const spriteEntry = getSpriteById(assignment.pixelSpriteId)
        if (spriteEntry) {
          const imageUrl = resolveRpgSpriteSrc(spriteEntry.src)
          if (imageUrl) {
            const texKey = `rpg-${assignment.pixelSpriteId}`
            createRpgCharacterTexture(this, imageUrl, texKey).then((key) => {
              const visual = this.agentManager?.getAgent(numericId)
              if (visual) {
                registerCharacterAnimations(this, key)
                visual.textureKey = key
                visual.sprite.setTexture(key, 1)
              }
            })
          }
        }
      }
    }
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

    // ── Pass 1: Draw floor tiles ──
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = tileMap[r][c]
        if (tile === TileType.VOID || tile === TileType.WALL) continue

        const x = c * TILE_SIZE
        const y = r * TILE_SIZE

        // Floor: use layout tileColors if available, otherwise warm wood plank palette
        const colorIdx = r * layout.cols + c
        const floorColor = layout.tileColors?.[colorIdx]
        const baseColor = floorColor
          ? this.floorColorToHex(floorColor)
          : PLANK_COLORS[r % PLANK_COLORS.length]

        g.fillStyle(baseColor, 1)
        g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

        // Add subtle plank line on top edge
        g.lineStyle(1, 0x000000, 0.08)
        g.lineBetween(x, y, x + TILE_SIZE, y)
      }
    }

    // ── Pass 2: Draw walls procedurally ──
    this.drawWalls(g, tileMap, rows, cols)
  }

  /**
   * Draw wall tiles procedurally with baseboard accents on all floor-adjacent edges,
   * stone mortar grid lines, and doorway shadow depth.
   */
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

        // Wall base fill
        g.fillStyle(WALL_BASE_COLOR, 1)
        g.fillRect(x, y, TILE_SIZE, TILE_SIZE)

        // Stone mortar grid lines — horizontal and vertical for textured look
        g.lineStyle(1, WALL_ACCENT_COLOR, 0.3)
        // Horizontal mortar lines every 4px
        for (let my = 4; my < TILE_SIZE; my += 4) {
          g.lineBetween(x, y + my, x + TILE_SIZE, y + my)
        }
        // Vertical mortar lines offset per row for a brick pattern
        const vOffset = (r % 2) * (TILE_SIZE / 2)
        for (let mx = vOffset; mx < TILE_SIZE; mx += TILE_SIZE) {
          g.lineStyle(1, WALL_ACCENT_COLOR, 0.2)
          g.lineBetween(x + (mx % TILE_SIZE), y, x + (mx % TILE_SIZE), y + TILE_SIZE)
        }
        // Subtle vertical accent line on left edge
        g.lineStyle(1, WALL_ACCENT_COLOR, 0.5)
        g.lineBetween(x, y, x, y + TILE_SIZE)

        // Baseboard accents on ALL edges adjacent to floor tiles
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

        // Doorway edge shadows — darker shadow on wall tiles that border a doorway
        // Check if this wall tile is next to a floor tile that forms a doorway opening
        if (hasFloorBelow || hasFloorAbove) {
          // Check if left or right neighbor is also floor (doorway edge)
          if (hasFloorLeft) {
            g.fillStyle(0x0a0a14, 0.4)
            g.fillRect(x, y, 2, TILE_SIZE)
          }
          if (hasFloorRight) {
            g.fillStyle(0x0a0a14, 0.4)
            g.fillRect(x + TILE_SIZE - 2, y, 2, TILE_SIZE)
          }
        }
      }
    }
  }

  /**
   * Convert FloorColor (HSL-ish) to a Phaser hex color number.
   * Improved conversion that produces warm, natural floor tones.
   */
  private floorColorToHex(color: FloorColor): number {
    const h = ((color.h % 360) + 360) % 360
    // Lower floor + steeper curve — negative b values produce truly dark tones
    const l = Math.max(0.06, Math.min(0.55, 0.25 + color.b / 150))
    const s = Math.max(0.08, Math.min(0.5, 0.25 + color.s / 200))

    // HSL → RGB (simplified)
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2

    let r1 = 0,
      g1 = 0,
      b1 = 0
    if (h < 60) {
      r1 = c
      g1 = x
      b1 = 0
    } else if (h < 120) {
      r1 = x
      g1 = c
      b1 = 0
    } else if (h < 180) {
      r1 = 0
      g1 = c
      b1 = x
    } else if (h < 240) {
      r1 = 0
      g1 = x
      b1 = c
    } else if (h < 300) {
      r1 = x
      g1 = 0
      b1 = c
    } else {
      r1 = c
      g1 = 0
      b1 = x
    }

    const ri = Math.round((r1 + m) * 255)
    const gi = Math.round((g1 + m) * 255)
    const bi = Math.round((b1 + m) * 255)
    return (ri << 16) | (gi << 8) | bi
  }

  // ═══════════════════════════════════════════════════════════════
  // Private: Furniture rendering (cached textures)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get or create a cached Phaser texture key for a SpriteData.
   * Textures are created once and reused by reference identity.
   */
  private getFurnitureTextureKey(sprite: SpriteData): string {
    const cached = this.furnitureTextureCache.get(sprite)
    if (cached) return cached

    const key = `furn-${this.furnitureTexCounter++}`
    registerSpriteDataTexture(this, key, sprite)
    this.furnitureTextureCache.set(sprite, key)
    return key
  }

  private createFurniture(): void {
    this.clearFurniture()
    const office = this.officeState
    if (!office) return

    for (const fi of office.furniture) {
      const key = this.getFurnitureTextureKey(fi.sprite)
      const img = this.add.image(fi.x, fi.y, key)
      img.setOrigin(0, 0)
      img.setDepth(fi.zY)
      if (fi.mirrored) img.setFlipX(true)
      this.furnitureSprites.push(img)
    }

    // Track reference for change detection
    this.lastFurnitureRef = office.furniture
  }

  private clearFurniture(): void {
    for (const sprite of this.furnitureSprites) {
      sprite.destroy()
    }
    this.furnitureSprites = []
  }

  /**
   * Update furniture sprites only when the furniture array reference changes.
   * Avoids recreating textures every frame (the old bug).
   */
  private updateFurniture(): void {
    const office = this.officeState
    if (!office) return

    // Only rebuild if the furniture array reference actually changed
    const newFurniture = office.furniture
    if (this.lastFurnitureRef === newFurniture) return
    this.lastFurnitureRef = newFurniture

    this.clearFurniture()
    for (const fi of newFurniture) {
      const key = this.getFurnitureTextureKey(fi.sprite)
      const img = this.add.image(fi.x, fi.y, key)
      img.setOrigin(0, 0)
      img.setDepth(fi.zY)
      if (fi.mirrored) img.setFlipX(true)
      this.furnitureSprites.push(img)
    }
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
  // Private: Ambient dust particles (Outworked-style)
  // ═══════════════════════════════════════════════════════════════

  private initDustParticles(): void {
    this.dustParticles = this.add.graphics()
    this.dustParticles.setDepth(500)

    // Seed initial dust motes
    const layout = this.officeState?.getLayout()
    if (!layout) return

    const worldW = layout.cols * TILE_SIZE
    const worldH = layout.rows * TILE_SIZE

    for (let i = 0; i < 20; i++) {
      this.spawnDustMote(worldW, worldH)
    }
  }

  private spawnDustMote(worldW: number, worldH: number): void {
    this.dustMotes.push({
      x: Math.random() * worldW,
      y: Math.random() * worldH,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 1.5 - 1, // Slight upward drift
      alpha: Math.random() * 0.3,
      life: 0,
      maxLife: 3 + Math.random() * 4
    })
  }

  private updateDustParticles(dt: number): void {
    if (!this.dustParticles) return

    const layout = this.officeState?.getLayout()
    if (!layout) return

    const worldW = layout.cols * TILE_SIZE
    const worldH = layout.rows * TILE_SIZE

    this.dustParticles.clear()

    for (let i = this.dustMotes.length - 1; i >= 0; i--) {
      const mote = this.dustMotes[i]
      mote.x += mote.vx * dt
      mote.y += mote.vy * dt
      mote.life += dt

      // Fade in and out
      const progress = mote.life / mote.maxLife
      let alpha = mote.alpha
      if (progress < 0.2) {
        alpha *= progress / 0.2
      } else if (progress > 0.8) {
        alpha *= (1 - progress) / 0.2
      }

      if (mote.life >= mote.maxLife) {
        this.dustMotes.splice(i, 1)
        this.spawnDustMote(worldW, worldH)
        continue
      }

      // Draw dust mote — warm amber/parchment tones (floating embers)
      const dustColors = [0xd4a855, 0xc89640, 0xe8c070, 0xb88830]
      const dustColor = dustColors[i % dustColors.length]
      this.dustParticles.fillStyle(dustColor, alpha)
      this.dustParticles.fillCircle(mote.x, mote.y, 0.5)
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
    this.dustParticles?.destroy()
    this.dustMotes = []
  }
}

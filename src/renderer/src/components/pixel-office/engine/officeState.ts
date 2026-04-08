// Adapted from pixel-agents: webview-ui/src/office/engine/officeState.ts
// Main state orchestrator. Delegates to domain managers for focused concerns.

import {
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  PALETTE_COUNT
} from '../constants'
import { BubbleManager, FurnitureAnimator, SeatManager, SubagentManager } from './state'
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap
} from '../layout/layoutSerializer'
import { getWalkableTiles } from '../layout/tileMap'
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  Seat,
  TileType as TileTypeVal
} from './types'
import { CharacterState, MATRIX_EFFECT_DURATION, TILE_SIZE } from './types'
import { createCharacter, updateCharacter } from './characters'
import { matrixEffectSeeds } from './matrixEffect'

export class OfficeState {
  layout: OfficeLayout
  tileMap: TileTypeVal[][]
  seats: Map<string, Seat>
  blockedTiles: Set<string>
  furniture: FurnitureInstance[]
  walkableTiles: Array<{ col: number; row: number }>
  /** Walkable tiles within the idle zone (break room) — idle agents wander here */
  idleZoneTiles: Array<{ col: number; row: number }> = []
  characters: Map<number, Character> = new Map()
  selectedAgentId: number | null = null
  cameraFollowId: number | null = null
  hoveredAgentId: number | null = null
  hoveredTile: { col: number; row: number } | null = null

  // ── Domain managers ───────────────────────────────────────
  private readonly seatMgr = new SeatManager()
  private readonly subagentMgr = new SubagentManager()
  private readonly furnitureAnim = new FurnitureAnimator()
  private readonly bubbleMgr = new BubbleManager()

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.seats = layoutToSeats(this.layout.furniture)
    this.blockedTiles = getBlockedTiles(this.layout.furniture)
    this.furniture = layoutToFurnitureInstances(this.layout.furniture)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.computeIdleZone()
  }

  // ── Layout management ─────────────────────────────────────

  /** Compute idle zone tiles from layout zones metadata */
  private computeIdleZone(): void {
    const zones = this.layout.zones
    if (zones?.breakRoom) {
      const z = zones.breakRoom
      this.idleZoneTiles = this.walkableTiles.filter(
        (t) => t.col >= z.colMin && t.col <= z.colMax && t.row >= z.rowMin && t.row <= z.rowMax
      )
    }
    if (this.idleZoneTiles.length === 0) {
      this.idleZoneTiles = this.walkableTiles
    }
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters. */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.seats = layoutToSeats(layout.furniture)
    this.blockedTiles = getBlockedTiles(layout.furniture)
    this.furniture = this.furnitureAnim.forceRebuild(layout, this.characters, this.seats)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
    this.computeIdleZone()

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col
        ch.tileRow += shift.row
        ch.x += shift.col * TILE_SIZE
        ch.y += shift.row * TILE_SIZE
        ch.path = []
        ch.moveProgress = 0
      }
    }

    // Reassign characters to new seats
    for (const seat of this.seats.values()) {
      seat.assigned = false
    }

    // First pass: keep characters at existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!
        if (!seat.assigned) {
          seat.assigned = true
          ch.tileCol = seat.seatCol
          ch.tileRow = seat.seatRow
          ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
          ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
          ch.dir = seat.facingDir
          continue
        }
      }
      ch.seatId = null
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue
      const seatId = this.seatMgr.findFreeSeat(this.seats)
      if (seatId) {
        this.seats.get(seatId)!.assigned = true
        ch.seatId = seatId
        const seat = this.seats.get(seatId)!
        ch.tileCol = seat.seatCol
        ch.tileRow = seat.seatRow
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
        ch.dir = seat.facingDir
      }
    }

    // Relocate characters outside bounds
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch)
      }
    }
  }

  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
    ch.tileCol = spawn.col
    ch.tileRow = spawn.row
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.moveProgress = 0
  }

  getLayout(): OfficeLayout {
    return this.layout
  }

  // ── Character lifecycle ───────────────────────────────────

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    const counts = new Array(PALETTE_COUNT).fill(0) as number[]
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue
      counts[ch.palette]++
    }
    const minCount = Math.min(...counts)
    const available: number[] = []
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) available.push(i)
    }
    const palette = available[Math.floor(Math.random() * available.length)]
    let hueShift = 0
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG)
    }
    return { palette, hueShift }
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string
  ): void {
    if (this.characters.has(id)) return

    let palette: number
    let hueShift: number
    if (preferredPalette !== undefined) {
      palette = preferredPalette
      hueShift = preferredHueShift ?? 0
    } else {
      const pick = this.pickDiversePalette()
      palette = pick.palette
      hueShift = pick.hueShift
    }

    let seatId: string | null = null
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!
      if (!seat.assigned) {
        seatId = preferredSeatId
      }
    }
    if (!seatId) {
      seatId = this.seatMgr.findFreeSeat(this.seats)
    }

    let ch: Character
    if (seatId) {
      const seat = this.seats.get(seatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, seatId, seat, hueShift)
    } else {
      const spawn =
        this.walkableTiles.length > 0
          ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
          : { col: 1, row: 1 }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }

    if (folderName) ch.folderName = folderName
    if (!skipSpawnEffect) {
      ch.matrixEffect = 'spawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
    }
    this.characters.set(id, ch)
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    if (ch.matrixEffect === 'despawn') return
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) seat.assigned = false
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
    ch.matrixEffect = 'despawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    ch.bubbleType = null
  }

  // ── Seat operations (delegated) ───────────────────────────

  getSeatAtTile(col: number, row: number): string | null {
    return this.seatMgr.getSeatAtTile(this.seats, col, row)
  }

  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    this.seatMgr.reassignSeat(ch, seatId, this.seats, this.tileMap, this.blockedTiles)
  }

  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    this.seatMgr.sendToSeat(ch, this.seats, this.tileMap, this.blockedTiles)
  }

  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId)
    if (!ch) return false
    return this.seatMgr.walkToTile(ch, col, row, this.seats, this.tileMap, this.blockedTiles)
  }

  // ── Subagent operations (delegated) ───────────────────────

  addSubagent(parentAgentId: number, parentToolId: string): number {
    return this.subagentMgr.addSubagent(
      parentAgentId,
      parentToolId,
      this.characters,
      this.seats,
      this.walkableTiles
    )
  }

  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const result = this.subagentMgr.removeSubagent(
      parentAgentId,
      parentToolId,
      this.characters,
      this.seats,
      this.selectedAgentId,
      this.cameraFollowId
    )
    this.selectedAgentId = result.selectedAgentId
    this.cameraFollowId = result.cameraFollowId
  }

  removeAllSubagents(parentAgentId: number): void {
    const result = this.subagentMgr.removeAllSubagents(
      parentAgentId,
      this.characters,
      this.seats,
      this.selectedAgentId,
      this.cameraFollowId
    )
    this.selectedAgentId = result.selectedAgentId
    this.cameraFollowId = result.cameraFollowId
  }

  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentMgr.getSubagentId(parentAgentId, parentToolId)
  }

  // ── Agent state ───────────────────────────────────────────

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.isActive = active
      if (!active) {
        ch.seatTimer = -1
        ch.path = []
        ch.moveProgress = 0
      }
      this.furnitureAnim.markDirty()
    }
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id)
    if (ch) ch.currentTool = tool
  }

  setAgentThought(id: number, thought: string | null): void {
    const ch = this.characters.get(id)
    if (ch) ch.currentThought = thought
  }

  // ── Bubble operations (delegated) ─────────────────────────

  showPermissionBubble(id: number): void {
    this.bubbleMgr.showPermissionBubble(this.characters, id)
  }

  clearPermissionBubble(id: number): void {
    this.bubbleMgr.clearPermissionBubble(this.characters, id)
  }

  showWaitingBubble(id: number): void {
    this.bubbleMgr.showWaitingBubble(this.characters, id)
  }

  dismissBubble(id: number): void {
    this.bubbleMgr.dismissBubble(this.characters, id)
  }

  // ── Game loop ─────────────────────────────────────────────

  update(dt: number): void {
    // Furniture animation
    const newFurniture = this.furnitureAnim.update(
      dt,
      this.layout,
      this.characters,
      this.seats,
      this.furniture
    )
    if (newFurniture) this.furniture = newFurniture

    const toDelete: number[] = []
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            ch.matrixEffect = null
            ch.matrixEffectTimer = 0
            ch.matrixEffectSeeds = []
          } else {
            toDelete.push(ch.id)
          }
        }
        continue
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.seatMgr.withOwnSeatUnblocked(ch, this.seats, this.blockedTiles, () =>
        updateCharacter(
          ch,
          dt,
          this.walkableTiles,
          this.seats,
          this.tileMap,
          this.blockedTiles,
          this.idleZoneTiles
        )
      )
    }

    // Tick bubble timers
    this.bubbleMgr.updateBubbles(this.characters, dt)

    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id)
    }
  }

  // ── Accessors ─────────────────────────────────────────────

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y)
    for (const ch of chars) {
      if (ch.matrixEffect === 'despawn') continue
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
      const anchorY = ch.y + sittingOffset
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH
      const top = anchorY - CHARACTER_HIT_HEIGHT
      const bottom = anchorY
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id
      }
    }
    return null
  }
}

/**
 * Manages sub-agent lifecycle: creation, removal, and ID tracking.
 * Extracted from OfficeState to reduce complexity.
 */
import type { Character, Seat } from '../types'
import { TILE_SIZE } from '../types'
import { createCharacter } from '../characters'
import { matrixEffectSeeds } from '../matrixEffect'

export class SubagentManager {
  /** Maps "parentId:toolId" -> sub-agent character ID (negative) */
  readonly idMap: Map<string, number> = new Map()
  /** Reverse lookup: sub-agent character ID -> parent info */
  readonly meta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map()
  private nextId = -1

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(
    parentAgentId: number,
    parentToolId: string,
    characters: Map<number, Character>,
    seats: Map<string, Seat>,
    walkableTiles: Array<{ col: number; row: number }>
  ): number {
    const key = `${parentAgentId}:${parentToolId}`
    if (this.idMap.has(key)) return this.idMap.get(key)!

    const id = this.nextId--
    const parentCh = characters.get(parentAgentId)
    const palette = parentCh ? parentCh.palette : 0
    const hueShift = parentCh ? parentCh.hueShift : 0

    // Find the free seat closest to the parent agent
    const parentCol = parentCh ? parentCh.tileCol : 0
    const parentRow = parentCh ? parentCh.tileRow : 0
    const dist = (c: number, r: number) => Math.abs(c - parentCol) + Math.abs(r - parentRow)

    let bestSeatId: string | null = null
    let bestDist = Infinity
    for (const [uid, seat] of seats) {
      if (!seat.assigned) {
        const d = dist(seat.seatCol, seat.seatRow)
        if (d < bestDist) {
          bestDist = d
          bestSeatId = uid
        }
      }
    }

    let ch: Character
    if (bestSeatId) {
      const seat = seats.get(bestSeatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift)
    } else {
      // No seats -- spawn at closest walkable tile to parent
      let spawn = { col: 1, row: 1 }
      if (walkableTiles.length > 0) {
        let closest = walkableTiles[0]
        let closestDist = dist(closest.col, closest.row)
        for (let i = 1; i < walkableTiles.length; i++) {
          const d = dist(walkableTiles[i].col, walkableTiles[i].row)
          if (d < closestDist) {
            closest = walkableTiles[i]
            closestDist = d
          }
        }
        spawn = closest
      }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }
    ch.isSubagent = true
    ch.parentAgentId = parentAgentId
    ch.matrixEffect = 'spawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    characters.set(id, ch)

    this.idMap.set(key, id)
    this.meta.set(id, { parentAgentId, parentToolId })
    return id
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(
    parentAgentId: number,
    parentToolId: string,
    characters: Map<number, Character>,
    seats: Map<string, Seat>,
    selectedAgentId: number | null,
    cameraFollowId: number | null
  ): { selectedAgentId: number | null; cameraFollowId: number | null } {
    const key = `${parentAgentId}:${parentToolId}`
    const id = this.idMap.get(key)
    if (id === undefined) return { selectedAgentId, cameraFollowId }

    const ch = characters.get(id)
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        this.idMap.delete(key)
        this.meta.delete(id)
        return { selectedAgentId, cameraFollowId }
      }
      if (ch.seatId) {
        const seat = seats.get(ch.seatId)
        if (seat) seat.assigned = false
      }
      ch.matrixEffect = 'despawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
      ch.bubbleType = null
    }
    this.idMap.delete(key)
    this.meta.delete(id)
    if (selectedAgentId === id) selectedAgentId = null
    if (cameraFollowId === id) cameraFollowId = null
    return { selectedAgentId, cameraFollowId }
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(
    parentAgentId: number,
    characters: Map<number, Character>,
    seats: Map<string, Seat>,
    selectedAgentId: number | null,
    cameraFollowId: number | null
  ): { selectedAgentId: number | null; cameraFollowId: number | null } {
    const toRemove: string[] = []
    for (const [key, id] of this.idMap) {
      const m = this.meta.get(id)
      if (m && m.parentAgentId === parentAgentId) {
        const ch = characters.get(id)
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            this.meta.delete(id)
            toRemove.push(key)
            continue
          }
          if (ch.seatId) {
            const seat = seats.get(ch.seatId)
            if (seat) seat.assigned = false
          }
          ch.matrixEffect = 'despawn'
          ch.matrixEffectTimer = 0
          ch.matrixEffectSeeds = matrixEffectSeeds()
          ch.bubbleType = null
        }
        this.meta.delete(id)
        if (selectedAgentId === id) selectedAgentId = null
        if (cameraFollowId === id) cameraFollowId = null
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.idMap.delete(key)
    }
    return { selectedAgentId, cameraFollowId }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.idMap.get(`${parentAgentId}:${parentToolId}`) ?? null
  }
}

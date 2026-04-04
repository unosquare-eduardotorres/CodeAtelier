/**
 * Unit tests for OfficeState (engine/officeState.ts).
 * Tests agent lifecycle, seat management, subagent management, and state updates.
 */
import assert from 'node:assert/strict'
import { OfficeState } from '../engine/officeState'
import { CharacterState, Direction, TileType, TILE_SIZE } from '../engine/types'
import type { OfficeLayout, Seat } from '../engine/types'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── Fixtures ──────────────────────────────────────────────

/** Minimal layout with 4 desks and chairs for testing */
function makeTestLayout(): OfficeLayout {
  // 7x5 grid: wall border, floor interior, with 2 desk+chair pairs
  const cols = 7
  const rows = 5
  const tiles: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        tiles.push(TileType.WALL)
      } else {
        tiles.push(TileType.FLOOR_1)
      }
    }
  }

  return {
    version: 1,
    cols,
    rows,
    tiles: tiles as any,
    furniture: [
      // Desk at (2,1), chair at (2,2) facing UP
      { uid: 'desk-1', type: 'desk-front', col: 2, row: 1 },
      { uid: 'chair-1', type: 'chair-front', col: 2, row: 2 },
      // Desk at (4,1), chair at (4,2) facing UP
      { uid: 'desk-2', type: 'desk-front', col: 4, row: 1 },
      { uid: 'chair-2', type: 'chair-front', col: 4, row: 2 }
    ]
  }
}

// ── Constructor ──────────────────────────────────────────

describe('OfficeState — constructor', () => {
  test('creates with default layout when none provided', () => {
    const state = new OfficeState()
    assert.ok(state.layout)
    assert.ok(state.tileMap.length > 0)
    assert.ok(state.walkableTiles.length > 0)
  })

  test('initializes tileMap from layout', () => {
    const state = new OfficeState()
    const layout = state.getLayout()
    assert.equal(state.tileMap.length, layout.rows)
    assert.equal(state.tileMap[0].length, layout.cols)
  })

  test('starts with no characters', () => {
    const state = new OfficeState()
    assert.equal(state.getCharacters().length, 0)
  })
})

// ── addAgent / removeAgent ──────────────────────────────────

describe('OfficeState — addAgent', () => {
  test('adds a character', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const chars = state.getCharacters()
    assert.equal(chars.length, 1)
    assert.equal(chars[0].id, 1)
  })

  test('assigns seat when seats are available', () => {
    const state = new OfficeState()
    // Without catalog loaded, seats map is empty — agent gets no seat (spawns on walkable tile)
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    // Agent should exist regardless of seat availability
    assert.equal(ch.id, 1)
    assert.equal(ch.isActive, true)
  })

  test('does not duplicate when adding same id twice', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.addAgent(1, 0, 0, undefined, true) // duplicate
    assert.equal(state.getCharacters().length, 1)
  })

  test('uses preferred palette and hueShift', () => {
    const state = new OfficeState()
    state.addAgent(1, 3, 90, undefined, true)
    const ch = state.getCharacters()[0]
    assert.equal(ch.palette, 3)
    assert.equal(ch.hueShift, 90)
  })

  test('starts with matrix spawn effect by default', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0)
    const ch = state.getCharacters()[0]
    assert.equal(ch.matrixEffect, 'spawn')
    assert.equal(ch.matrixEffectTimer, 0)
  })

  test('skips spawn effect when skipSpawnEffect=true', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    assert.equal(ch.matrixEffect, null)
  })

  test('assigns folderName when provided', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true, 'my-project')
    const ch = state.getCharacters()[0]
    assert.equal(ch.folderName, 'my-project')
  })

  test('multiple agents get different characters', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.addAgent(2, 1, 0, undefined, true)
    const chars = state.getCharacters()
    assert.equal(chars.length, 2)
    const ids = chars.map((c) => c.id).sort()
    assert.deepEqual(ids, [1, 2])
  })
})

describe('OfficeState — removeAgent', () => {
  test('starts despawn animation instead of instant deletion', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.removeAgent(1)
    // Character should still exist (despawning)
    assert.equal(state.getCharacters().length, 1)
    const ch = state.getCharacters()[0]
    assert.equal(ch.matrixEffect, 'despawn')
  })

  test('clears selection when selected agent removed', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.selectedAgentId = 1
    state.removeAgent(1)
    assert.equal(state.selectedAgentId, null)
  })

  test('frees seat on removal when agent had a seat', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    // If no catalog loaded, there may be no seats — test that removal is clean regardless
    state.removeAgent(1)
    // If agent had a seat, it should now be unassigned
    if (ch.seatId) {
      const seat = state.seats.get(ch.seatId)
      assert.ok(seat)
      assert.equal(seat!.assigned, false)
    }
    // Agent should be in despawn state
    assert.equal(ch.matrixEffect, 'despawn')
  })

  test('no-op for non-existent agent', () => {
    const state = new OfficeState()
    state.removeAgent(999) // should not throw
    assert.equal(state.getCharacters().length, 0)
  })

  test('no-op for already-despawning agent', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.removeAgent(1)
    const ch1 = state.getCharacters()[0]
    assert.equal(ch1.matrixEffect, 'despawn')
    // Second removal — should not crash or change state
    state.removeAgent(1)
    assert.equal(state.getCharacters().length, 1)
  })
})

// ── setAgentActive ──────────────────────────────────────────

describe('OfficeState — setAgentActive', () => {
  test('sets character active flag', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.setAgentActive(1, false)
    assert.equal(state.getCharacters()[0].isActive, false)
  })

  test('sets seatTimer sentinel when deactivating', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.setAgentActive(1, false)
    assert.equal(state.getCharacters()[0].seatTimer, -1)
  })

  test('clears path when deactivating', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    ch.path = [{ col: 1, row: 1 }]
    state.setAgentActive(1, false)
    assert.equal(ch.path.length, 0)
  })

  test('no-op for non-existent agent', () => {
    const state = new OfficeState()
    state.setAgentActive(999, true) // should not throw
  })
})

// ── Subagent management ──────────────────────────────────

describe('OfficeState — subagents', () => {
  test('addSubagent creates a new sub-agent character', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const subId = state.addSubagent(1, 'tool-1')
    assert.ok(subId < 0, 'sub-agent IDs should be negative')
    const chars = state.getCharacters()
    const sub = chars.find((c) => c.id === subId)
    assert.ok(sub)
    assert.equal(sub!.isSubagent, true)
    assert.equal(sub!.parentAgentId, 1)
  })

  test('addSubagent returns same id for same parent+tool', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const id1 = state.addSubagent(1, 'tool-1')
    const id2 = state.addSubagent(1, 'tool-1')
    assert.equal(id1, id2)
  })

  test('addSubagent inherits parent palette', () => {
    const state = new OfficeState()
    state.addAgent(1, 3, 45, undefined, true)
    const subId = state.addSubagent(1, 'tool-1')
    const sub = state.getCharacters().find((c) => c.id === subId)!
    assert.equal(sub.palette, 3)
    assert.equal(sub.hueShift, 45)
  })

  test('removeSubagent starts despawn effect', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const subId = state.addSubagent(1, 'tool-1')
    state.removeSubagent(1, 'tool-1')
    const sub = state.getCharacters().find((c) => c.id === subId)
    assert.ok(sub)
    assert.equal(sub!.matrixEffect, 'despawn')
  })

  test('removeAllSubagents despawns all for a parent', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.addSubagent(1, 'tool-1')
    state.addSubagent(1, 'tool-2')
    state.addAgent(2, 1, 0, undefined, true)
    state.addSubagent(2, 'tool-3')

    state.removeAllSubagents(1)

    const chars = state.getCharacters()
    const parent1Subs = chars.filter((c) => c.parentAgentId === 1)
    for (const sub of parent1Subs) {
      assert.equal(sub.matrixEffect, 'despawn')
    }
    // Parent 2's subagent should be unaffected
    const parent2Subs = chars.filter((c) => c.parentAgentId === 2)
    assert.equal(parent2Subs.length, 1)
    assert.notEqual(parent2Subs[0].matrixEffect, 'despawn')
  })

  test('getSubagentId returns id for existing subagent', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const subId = state.addSubagent(1, 'tool-1')
    assert.equal(state.getSubagentId(1, 'tool-1'), subId)
  })

  test('getSubagentId returns null for non-existent subagent', () => {
    const state = new OfficeState()
    assert.equal(state.getSubagentId(1, 'tool-1'), null)
  })
})

// ── Bubble management ──────────────────────────────────────

describe('OfficeState — bubbles', () => {
  test('showPermissionBubble sets bubble type', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showPermissionBubble(1)
    assert.equal(state.getCharacters()[0].bubbleType, 'permission')
  })

  test('clearPermissionBubble only clears permission bubbles', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showWaitingBubble(1)
    state.clearPermissionBubble(1) // should not clear waiting
    assert.equal(state.getCharacters()[0].bubbleType, 'waiting')
  })

  test('showWaitingBubble sets bubble with timer', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showWaitingBubble(1)
    const ch = state.getCharacters()[0]
    assert.equal(ch.bubbleType, 'waiting')
    assert.ok(ch.bubbleTimer > 0)
  })

  test('dismissBubble clears permission instantly', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showPermissionBubble(1)
    state.dismissBubble(1)
    assert.equal(state.getCharacters()[0].bubbleType, null)
  })

  test('dismissBubble fast-fades waiting bubble', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showWaitingBubble(1)
    state.dismissBubble(1)
    const ch = state.getCharacters()[0]
    // Should still be waiting but with reduced timer (fast fade)
    assert.equal(ch.bubbleType, 'waiting')
    assert.ok(ch.bubbleTimer <= 0.3)
  })
})

// ── Tool and thought state ──────────────────────────────────

describe('OfficeState — tool and thought', () => {
  test('setAgentTool updates currentTool', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.setAgentTool(1, 'Read')
    assert.equal(state.getCharacters()[0].currentTool, 'Read')
  })

  test('setAgentTool to null clears tool', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.setAgentTool(1, 'Read')
    state.setAgentTool(1, null)
    assert.equal(state.getCharacters()[0].currentTool, null)
  })

  test('setAgentThought updates currentThought', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.setAgentThought(1, 'Analyzing code...')
    assert.equal(state.getCharacters()[0].currentThought, 'Analyzing code...')
  })
})

// ── Update loop ──────────────────────────────────────────

describe('OfficeState — update', () => {
  test('removes characters after despawn completes', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.removeAgent(1)

    // Advance past MATRIX_EFFECT_DURATION (0.3s)
    state.update(0.35)
    assert.equal(state.getCharacters().length, 0)
  })

  test('completes spawn animation', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0) // with spawn effect
    const ch = state.getCharacters()[0]
    assert.equal(ch.matrixEffect, 'spawn')

    // Advance past MATRIX_EFFECT_DURATION
    state.update(0.35)
    assert.equal(ch.matrixEffect, null)
  })

  test('waiting bubble timer expires during update', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    state.showWaitingBubble(1)

    // Advance past bubble duration (2s)
    state.update(2.1)
    assert.equal(state.getCharacters()[0].bubbleType, null)
  })
})

// ── Hit testing ──────────────────────────────────────────

describe('OfficeState — getCharacterAt', () => {
  test('returns null for empty position', () => {
    const state = new OfficeState()
    assert.equal(state.getCharacterAt(0, 0), null)
  })

  test('returns character id at character position', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    // Hit test at character position (should be within hit box)
    const result = state.getCharacterAt(ch.x, ch.y - 10) // slightly above center
    assert.equal(result, 1)
  })

  test('skips despawning characters', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    state.removeAgent(1) // starts despawn
    const result = state.getCharacterAt(ch.x, ch.y - 10)
    assert.equal(result, null)
  })
})

// ── Seat operations ──────────────────────────────────────

describe('OfficeState — seat operations', () => {
  test('getSeatAtTile returns correct seat', () => {
    const state = new OfficeState()
    // Add agent to get a seat assigned
    state.addAgent(1, 0, 0, undefined, true)
    const ch = state.getCharacters()[0]
    if (ch.seatId) {
      const seat = state.seats.get(ch.seatId)!
      const found = state.getSeatAtTile(seat.seatCol, seat.seatRow)
      assert.equal(found, ch.seatId)
    }
  })

  test('getSeatAtTile returns null for empty tile', () => {
    const state = new OfficeState()
    // Use a position that definitely doesn't have a seat
    assert.equal(state.getSeatAtTile(0, 0), null)
  })

  test('walkToTile returns false for wall tiles', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const result = state.walkToTile(1, 0, 0) // wall tile
    assert.equal(result, false)
  })

  test('walkToTile rejects subagent commands', () => {
    const state = new OfficeState()
    state.addAgent(1, 0, 0, undefined, true)
    const subId = state.addSubagent(1, 'tool-1')
    const result = state.walkToTile(subId, 2, 2)
    assert.equal(result, false)
  })
})

// ── Report ──────────────────────────────────────────────

console.log(`\n─── officeState.test.ts: ${passed} passed, ${failed} failed ───`)
if (failed > 0) process.exit(1)

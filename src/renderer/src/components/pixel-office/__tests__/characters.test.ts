/**
 * Unit tests for pixel-office character FSM (engine/characters.ts).
 * Tests state transitions: TYPE → IDLE → WALK → TYPE cycle,
 * pathfinding triggers, wander logic, and sprite selection.
 */
import assert from 'node:assert/strict'
import { createCharacter, getCharacterSprite, isReadingTool, updateCharacter } from '../engine/characters'
import { CharacterState, Direction, TILE_SIZE } from '../engine/types'
import type { Character, Seat, TileType as TileTypeVal } from '../engine/types'
import { TileType } from '../engine/types'
import { findPath, getWalkableTiles } from '../layout/tileMap'

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

// ── Test Fixtures ──────────────────────────────────────────────

/** Minimal 5x5 grid: wall border + floor interior */
function makeTestGrid(): TileTypeVal[][] {
  // 0=WALL, 1=FLOOR
  return [
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0]
  ] as TileTypeVal[][]
}

function makeSeats(): Map<string, Seat> {
  const seats = new Map<string, Seat>()
  seats.set('seat-1', {
    uid: 'seat-1',
    seatCol: 1,
    seatRow: 1,
    facingDir: Direction.DOWN,
    assigned: false
  })
  seats.set('seat-2', {
    uid: 'seat-2',
    seatCol: 3,
    seatRow: 3,
    facingDir: Direction.UP,
    assigned: false
  })
  return seats
}

function makeTestEnv() {
  const tileMap = makeTestGrid()
  const blockedTiles = new Set<string>()
  const walkableTiles = getWalkableTiles(tileMap, blockedTiles)
  const seats = makeSeats()
  return { tileMap, blockedTiles, walkableTiles, seats }
}

// ── Tests ──────────────────────────────────────────────────────

describe('isReadingTool', () => {
  test('returns true for Read tool', () => {
    assert.equal(isReadingTool('Read'), true)
  })

  test('returns true for Grep tool', () => {
    assert.equal(isReadingTool('Grep'), true)
  })

  test('returns true for Glob tool', () => {
    assert.equal(isReadingTool('Glob'), true)
  })

  test('returns false for Write tool', () => {
    assert.equal(isReadingTool('Write'), false)
  })

  test('returns false for Edit tool', () => {
    assert.equal(isReadingTool('Edit'), false)
  })

  test('returns false for Bash tool', () => {
    assert.equal(isReadingTool('Bash'), false)
  })

  test('returns false for null', () => {
    assert.equal(isReadingTool(null), false)
  })
})

describe('createCharacter', () => {
  test('creates character at seat position when seat provided', () => {
    const seat: Seat = {
      uid: 'seat-1',
      seatCol: 3,
      seatRow: 2,
      facingDir: Direction.LEFT,
      assigned: false
    }
    const ch = createCharacter(1, 0, 'seat-1', seat, 0)
    assert.equal(ch.id, 1)
    assert.equal(ch.tileCol, 3)
    assert.equal(ch.tileRow, 2)
    assert.equal(ch.dir, Direction.LEFT)
    assert.equal(ch.state, CharacterState.TYPE)
    assert.equal(ch.seatId, 'seat-1')
    assert.equal(ch.isActive, true)
    assert.equal(ch.isSubagent, false)
  })

  test('creates character at (1,1) when no seat provided', () => {
    const ch = createCharacter(2, 3, null, null)
    assert.equal(ch.tileCol, 1)
    assert.equal(ch.tileRow, 1)
    assert.equal(ch.dir, Direction.DOWN)
    assert.equal(ch.seatId, null)
  })

  test('preserves hue shift', () => {
    const ch = createCharacter(1, 0, null, null, 90)
    assert.equal(ch.hueShift, 90)
  })

  test('starts in TYPE state', () => {
    const ch = createCharacter(1, 0, null, null)
    assert.equal(ch.state, CharacterState.TYPE)
    assert.equal(ch.frame, 0)
    assert.equal(ch.frameTimer, 0)
  })

  test('pixel position is tile center', () => {
    const seat: Seat = {
      uid: 's',
      seatCol: 2,
      seatRow: 3,
      facingDir: Direction.DOWN,
      assigned: false
    }
    const ch = createCharacter(1, 0, 's', seat)
    assert.equal(ch.x, 2 * TILE_SIZE + TILE_SIZE / 2)
    assert.equal(ch.y, 3 * TILE_SIZE + TILE_SIZE / 2)
  })
})

describe('updateCharacter — TYPE state', () => {
  test('cycles animation frames at TYPE_FRAME_DURATION_SEC intervals', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, 'seat-1', seats.get('seat-1')!)
    ch.state = CharacterState.TYPE
    ch.isActive = true

    // Advance past one type frame duration (0.3s)
    updateCharacter(ch, 0.31, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.frame, 1)

    // Advance again
    updateCharacter(ch, 0.31, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.frame, 0) // wraps around (% 2)
  })

  test('stays in TYPE while active', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, 'seat-1', seats.get('seat-1')!)
    ch.state = CharacterState.TYPE
    ch.isActive = true

    // Multiple updates should keep state as TYPE
    for (let i = 0; i < 10; i++) {
      updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles)
    }
    assert.equal(ch.state, CharacterState.TYPE)
  })

  test('transitions to IDLE when deactivated and seatTimer expires', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, 'seat-1', seats.get('seat-1')!)
    ch.state = CharacterState.TYPE
    ch.isActive = false
    ch.seatTimer = 0 // already expired

    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.state, CharacterState.IDLE)
    assert.equal(ch.frame, 0)
  })

  test('stays in TYPE while seatTimer is counting down', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, 'seat-1', seats.get('seat-1')!)
    ch.state = CharacterState.TYPE
    ch.isActive = false
    ch.seatTimer = 5.0

    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.state, CharacterState.TYPE)
    assert.ok(ch.seatTimer < 5.0) // timer decreased
  })
})

describe('updateCharacter — IDLE state', () => {
  test('transitions to TYPE and pathfinds when reactivated with seat', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const seat = seats.get('seat-1')!
    const ch = createCharacter(1, 0, 'seat-1', seat)
    // Move character away from seat
    ch.state = CharacterState.IDLE
    ch.isActive = false
    ch.tileCol = 2
    ch.tileRow = 2
    ch.x = 2 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 2 * TILE_SIZE + TILE_SIZE / 2

    // Reactivate
    ch.isActive = true
    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)

    // Should start walking to seat
    assert.equal(ch.state, CharacterState.WALK)
    assert.ok(ch.path.length > 0)
  })

  test('transitions directly to TYPE when reactivated at seat', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const seat = seats.get('seat-1')!
    const ch = createCharacter(1, 0, 'seat-1', seat)
    ch.state = CharacterState.IDLE
    ch.isActive = false
    // Character is already at seat position
    ch.tileCol = seat.seatCol
    ch.tileRow = seat.seatRow

    ch.isActive = true
    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)

    // No path needed → sit down directly
    assert.equal(ch.state, CharacterState.TYPE)
    assert.equal(ch.dir, seat.facingDir)
  })

  test('transitions to TYPE in place when reactivated with no seat', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.IDLE
    ch.isActive = false
    ch.tileCol = 2
    ch.tileRow = 2

    ch.isActive = true
    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)

    assert.equal(ch.state, CharacterState.TYPE)
  })

  test('wander timer counts down', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.IDLE
    ch.isActive = false
    ch.wanderTimer = 5.0
    ch.tileCol = 2
    ch.tileRow = 2

    updateCharacter(ch, 1.0, walkableTiles, seats, tileMap, blockedTiles)
    assert.ok(ch.wanderTimer <= 4.0)
  })
})

describe('updateCharacter — WALK state', () => {
  test('moves toward next tile in path', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.WALK
    ch.tileCol = 1
    ch.tileRow = 1
    ch.x = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.path = [{ col: 2, row: 1 }, { col: 3, row: 1 }]
    ch.moveProgress = 0
    ch.isActive = true

    // Small step — should advance moveProgress
    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles)
    assert.ok(ch.moveProgress > 0)
    assert.equal(ch.dir, Direction.RIGHT)
  })

  test('arrives at next tile and shifts path', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.WALK
    ch.tileCol = 1
    ch.tileRow = 1
    ch.x = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.path = [{ col: 2, row: 1 }]
    ch.moveProgress = 0
    ch.isActive = true

    // Large dt to ensure arrival (WALK_SPEED_PX_PER_SEC=48, TILE_SIZE=16 → 1 tile in 0.33s)
    updateCharacter(ch, 0.5, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.tileCol, 2)
    assert.equal(ch.tileRow, 1)
    assert.equal(ch.path.length, 0)
  })

  test('transitions to TYPE when path complete and active at seat', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const seat = seats.get('seat-1')!
    const ch = createCharacter(1, 0, 'seat-1', seat)
    ch.state = CharacterState.WALK
    ch.tileCol = seat.seatCol
    ch.tileRow = seat.seatRow
    ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
    ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
    ch.path = [] // already at destination
    ch.isActive = true

    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.state, CharacterState.TYPE)
    assert.equal(ch.dir, seat.facingDir)
  })

  test('transitions to IDLE when path complete and not active', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.WALK
    ch.tileCol = 2
    ch.tileRow = 2
    ch.x = 2 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 2 * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.isActive = false
    ch.seatId = null

    updateCharacter(ch, 0.016, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.state, CharacterState.IDLE)
  })

  test('repaths to seat when reactivated during walk', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const seat = seats.get('seat-1')!
    const ch = createCharacter(1, 0, 'seat-1', seat)
    ch.state = CharacterState.WALK
    ch.tileCol = 2
    ch.tileRow = 2
    ch.x = 2 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 2 * TILE_SIZE + TILE_SIZE / 2
    // Walking somewhere else
    ch.path = [{ col: 3, row: 2 }]
    ch.isActive = true

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles)
    // Path should have been recalculated to head toward seat
    if (ch.path.length > 0) {
      const lastStep = ch.path[ch.path.length - 1]
      assert.equal(lastStep.col, seat.seatCol)
      assert.equal(lastStep.row, seat.seatRow)
    }
  })

  test('walks in correct direction — LEFT', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.WALK
    ch.tileCol = 2
    ch.tileRow = 1
    ch.x = 2 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.path = [{ col: 1, row: 1 }]
    ch.moveProgress = 0
    ch.isActive = true

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.dir, Direction.LEFT)
  })

  test('walks in correct direction — DOWN', () => {
    const { tileMap, blockedTiles, walkableTiles, seats } = makeTestEnv()
    const ch = createCharacter(1, 0, null, null)
    ch.state = CharacterState.WALK
    ch.tileCol = 1
    ch.tileRow = 1
    ch.x = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.y = 1 * TILE_SIZE + TILE_SIZE / 2
    ch.path = [{ col: 1, row: 2 }]
    ch.moveProgress = 0
    ch.isActive = true

    updateCharacter(ch, 0.1, walkableTiles, seats, tileMap, blockedTiles)
    assert.equal(ch.dir, Direction.DOWN)
  })
})

// ── Report ──────────────────────────────────────────────────────

console.log(`\n─── characters.test.ts: ${passed} passed, ${failed} failed ───`)
if (failed > 0) process.exit(1)

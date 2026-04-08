/**
 * Unit tests for catalogBuilder pipeline stages.
 * Each stage is tested independently with minimal input data.
 */
import assert from 'node:assert/strict'
import type { SpriteData } from '../engine/types'
import type { LoadedAssetData } from '../layout/furnitureCatalog'
import {
  buildCatalogEntries,
  createMirrorEntries,
  detectRotationGroups,
  detectStatePairs,
  detectAnimationGroups,
  buildVisibleCatalog
} from '../layout/catalogBuilder'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── Fixtures ───────────────────────────────────────────────

function sprite(w = 16, h = 16): SpriteData {
  return Array.from({ length: h }, () => new Array(w).fill('#FFF'))
}

function makeAssets(overrides?: Partial<LoadedAssetData>): LoadedAssetData {
  return {
    catalog: [
      {
        id: 'DESK_FRONT',
        label: 'Desk - Front',
        category: 'desks',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
        groupId: 'desk',
        orientation: 'front'
      },
      {
        id: 'DESK_BACK',
        label: 'Desk - Back',
        category: 'desks',
        width: 32,
        height: 16,
        footprintW: 2,
        footprintH: 1,
        isDesk: true,
        groupId: 'desk',
        orientation: 'back'
      },
      {
        id: 'LAMP_SIDE',
        label: 'Lamp - Side',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'lamp',
        orientation: 'side',
        mirrorSide: true
      },
      {
        id: 'LAMP_FRONT',
        label: 'Lamp - Front',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'lamp',
        orientation: 'front'
      },
      {
        id: 'PC_FRONT_OFF',
        label: 'PC - Front - Off',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'pc',
        orientation: 'front',
        state: 'off'
      },
      {
        id: 'PC_FRONT_ON',
        label: 'PC - Front - On',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        groupId: 'pc',
        orientation: 'front',
        state: 'on'
      },
      {
        id: 'FAN_ON_F0',
        label: 'Fan Frame 0',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        animationGroup: 'fan-anim',
        frame: 0
      },
      {
        id: 'FAN_ON_F1',
        label: 'Fan Frame 1',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        animationGroup: 'fan-anim',
        frame: 1
      },
      {
        id: 'FAN_ON_F2',
        label: 'Fan Frame 2',
        category: 'electronics',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        animationGroup: 'fan-anim',
        frame: 2
      },
      {
        id: 'PLANT',
        label: 'Plant',
        category: 'decor',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false
      }
    ],
    sprites: {
      DESK_FRONT: sprite(),
      DESK_BACK: sprite(),
      LAMP_SIDE: sprite(),
      LAMP_FRONT: sprite(),
      PC_FRONT_OFF: sprite(),
      PC_FRONT_ON: sprite(),
      FAN_ON_F0: sprite(),
      FAN_ON_F1: sprite(),
      FAN_ON_F2: sprite(),
      PLANT: sprite()
    },
    ...overrides
  }
}

// ── buildCatalogEntries ────────────────────────────────────

describe('buildCatalogEntries', () => {
  test('creates entries for all assets with sprites', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    assert.equal(entries.length, 10)
  })

  test('skips assets without sprite data', () => {
    const assets = makeAssets()
    delete (assets.sprites as any)['PLANT']
    const entries = buildCatalogEntries(assets)
    assert.equal(entries.length, 9)
    assert.ok(!entries.find((e) => e.type === 'PLANT'))
  })

  test('maps asset fields correctly', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const desk = entries.find((e) => e.type === 'DESK_FRONT')!
    assert.equal(desk.label, 'Desk - Front')
    assert.equal(desk.footprintW, 2)
    assert.equal(desk.footprintH, 1)
    assert.equal(desk.isDesk, true)
    assert.equal(desk.category, 'desks')
    assert.equal(desk.orientation, 'front')
  })

  test('includes optional fields only when truthy', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const plant = entries.find((e) => e.type === 'PLANT')!
    assert.equal(plant.orientation, undefined)
    assert.equal(plant.canPlaceOnSurfaces, undefined)
    assert.equal(plant.mirrorSide, undefined)
  })
})

// ── createMirrorEntries ────────────────────────────────────

describe('createMirrorEntries', () => {
  test('creates :left entry for mirrorSide + side orientation', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const mirrors = createMirrorEntries(entries, assets)
    assert.equal(mirrors.length, 1)
    assert.equal(mirrors[0].type, 'LAMP_SIDE:left')
    assert.equal(mirrors[0].orientation, 'left')
    assert.equal(mirrors[0].mirrorSide, true)
  })

  test('does not create mirrors for non-mirrorSide assets', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'A',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          orientation: 'side'
        }
      ],
      sprites: { A: sprite() }
    }
    const entries = buildCatalogEntries(assets)
    const mirrors = createMirrorEntries(entries, assets)
    assert.equal(mirrors.length, 0)
  })

  test('does not create mirrors for non-side orientations', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'A',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          orientation: 'front',
          mirrorSide: true
        }
      ],
      sprites: { A: sprite() }
    }
    const entries = buildCatalogEntries(assets)
    const mirrors = createMirrorEntries(entries, assets)
    assert.equal(mirrors.length, 0)
  })
})

// ── detectRotationGroups ────────────────────────────────────

describe('detectRotationGroups', () => {
  test('groups assets by groupId + orientation', () => {
    const assets = makeAssets()
    const { rotationGroups } = detectRotationGroups(assets)
    // desk group: front + back = 2 orientations
    assert.ok(rotationGroups.has('DESK_FRONT'))
    assert.ok(rotationGroups.has('DESK_BACK'))
    const group = rotationGroups.get('DESK_FRONT')!
    assert.deepEqual(group.orientations, ['front', 'back'])
    assert.equal(group.members['front'], 'DESK_FRONT')
    assert.equal(group.members['back'], 'DESK_BACK')
  })

  test('registers side as right and creates left for mirrorSide', () => {
    const assets = makeAssets()
    const { rotationGroups } = detectRotationGroups(assets)
    // lamp group: front + right (side) + left (mirror)
    assert.ok(rotationGroups.has('LAMP_FRONT'))
    const lampGroup = rotationGroups.get('LAMP_FRONT')!
    assert.ok(lampGroup.orientations.includes('right'))
    assert.ok(lampGroup.orientations.includes('left'))
  })

  test('tracks non-front IDs', () => {
    const assets = makeAssets()
    const { nonFrontIds } = detectRotationGroups(assets)
    assert.ok(nonFrontIds.has('DESK_BACK'))
    assert.ok(!nonFrontIds.has('DESK_FRONT'))
  })

  test('skips groups with only 1 orientation', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'SOLO',
          label: 'Solo',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          groupId: 'solo',
          orientation: 'front'
        }
      ],
      sprites: { SOLO: sprite() }
    }
    const { rotationGroups } = detectRotationGroups(assets)
    assert.equal(rotationGroups.size, 0)
  })

  test('skips "on" state variants in rotation collection', () => {
    const assets = makeAssets()
    const { rotationGroups } = detectRotationGroups(assets)
    // PC_FRONT_ON should not be directly in rotation groups from this stage
    // (it gets added later by registerOnStateRotations)
    assert.ok(!rotationGroups.has('PC_FRONT_ON'))
  })
})

// ── detectStatePairs ────────────────────────────────────────

describe('detectStatePairs', () => {
  test('creates on/off pairs', () => {
    const assets = makeAssets()
    const { stateGroups, offToOn, onToOff } = detectStatePairs(assets)
    assert.equal(stateGroups.get('PC_FRONT_OFF'), 'PC_FRONT_ON')
    assert.equal(stateGroups.get('PC_FRONT_ON'), 'PC_FRONT_OFF')
    assert.equal(offToOn.get('PC_FRONT_OFF'), 'PC_FRONT_ON')
    assert.equal(onToOff.get('PC_FRONT_ON'), 'PC_FRONT_OFF')
  })

  test('returns empty maps when no state pairs exist', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'A',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false
        }
      ],
      sprites: { A: sprite() }
    }
    const { stateGroups } = detectStatePairs(assets)
    assert.equal(stateGroups.size, 0)
  })
})

// ── detectAnimationGroups ───────────────────────────────────

describe('detectAnimationGroups', () => {
  test('groups animation frames by animationGroup', () => {
    const assets = makeAssets()
    const groups = detectAnimationGroups(assets)
    // fan-anim group with 3 frames, keyed by first frame ID
    assert.ok(groups.has('FAN_ON_F0'))
    const frames = groups.get('FAN_ON_F0')!
    assert.equal(frames.length, 3)
    assert.deepEqual(frames, ['FAN_ON_F0', 'FAN_ON_F1', 'FAN_ON_F2'])
  })

  test('sorts frames by frame index', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'A2',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          animationGroup: 'test',
          frame: 2
        },
        {
          id: 'A0',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          animationGroup: 'test',
          frame: 0
        },
        {
          id: 'A1',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false,
          animationGroup: 'test',
          frame: 1
        }
      ],
      sprites: { A0: sprite(), A1: sprite(), A2: sprite() }
    }
    const groups = detectAnimationGroups(assets)
    const frames = groups.get('A0')!
    assert.deepEqual(frames, ['A0', 'A1', 'A2'])
  })

  test('returns empty map when no animation groups', () => {
    const assets: LoadedAssetData = {
      catalog: [
        {
          id: 'A',
          label: 'A',
          category: 'decor',
          width: 16,
          height: 16,
          footprintW: 1,
          footprintH: 1,
          isDesk: false
        }
      ],
      sprites: { A: sprite() }
    }
    const groups = detectAnimationGroups(assets)
    assert.equal(groups.size, 0)
  })
})

// ── buildVisibleCatalog ─────────────────────────────────────

describe('buildVisibleCatalog', () => {
  test('excludes non-front IDs', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const mirrors = createMirrorEntries(entries, assets)
    entries.push(...mirrors)
    const { rotationGroups, nonFrontIds } = detectRotationGroups(assets)
    const { stateGroups } = detectStatePairs(assets)

    const { visibleEntries } = buildVisibleCatalog(
      entries,
      assets,
      nonFrontIds,
      rotationGroups,
      stateGroups
    )
    assert.ok(!visibleEntries.find((e) => e.type === 'DESK_BACK'))
    assert.ok(visibleEntries.find((e) => e.type === 'DESK_FRONT'))
  })

  test('excludes "on" state variants', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const { rotationGroups, nonFrontIds } = detectRotationGroups(assets)
    const { stateGroups } = detectStatePairs(assets)

    const { visibleEntries } = buildVisibleCatalog(
      entries,
      assets,
      nonFrontIds,
      rotationGroups,
      stateGroups
    )
    assert.ok(!visibleEntries.find((e) => e.type === 'PC_FRONT_ON'))
    assert.ok(visibleEntries.find((e) => e.type === 'PC_FRONT_OFF'))
  })

  test('strips label suffixes for grouped entries', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const { rotationGroups, nonFrontIds } = detectRotationGroups(assets)
    const { stateGroups } = detectStatePairs(assets)

    const { visibleEntries } = buildVisibleCatalog(
      entries,
      assets,
      nonFrontIds,
      rotationGroups,
      stateGroups
    )
    const pc = visibleEntries.find((e) => e.type === 'PC_FRONT_OFF')!
    // Should strip " - Front - Off" → "PC"
    assert.equal(pc.label, 'PC')
  })

  test('returns sorted unique categories', () => {
    const assets = makeAssets()
    const entries = buildCatalogEntries(assets)
    const { rotationGroups, nonFrontIds } = detectRotationGroups(assets)
    const { stateGroups } = detectStatePairs(assets)

    const { categories } = buildVisibleCatalog(
      entries,
      assets,
      nonFrontIds,
      rotationGroups,
      stateGroups
    )
    assert.ok(categories.length > 0)
    // Verify sorted
    for (let i = 1; i < categories.length; i++) {
      assert.ok(categories[i] >= categories[i - 1], 'Categories should be sorted')
    }
  })
})

// ── Report ──────────────────────────────────────────────────

console.log(`\n--- catalogBuilder.test.ts: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)

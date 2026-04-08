/**
 * PhaserSpriteLoader — Converts existing PNG assets into Phaser textures and animations.
 *
 * Uses runtime conversion (Option B from plan): loads PNGs via the existing assetLoader,
 * renders SpriteData[][] onto HTMLCanvasElement, and registers them as Phaser textures.
 * Also creates Phaser animation definitions for walk/type/idle/reading states.
 */

import Phaser from 'phaser'

import type { SpriteData } from '../engine/types'
import { adjustSprite } from '../colorize'
import { resolveBubbleSprite } from '../sprites/spriteData'
import { loadImage, imageToSpriteData } from '../sprites/imageUtils'
import { flipSpriteH, pixelDataToSpriteData, spriteDataToPixelData } from '../sprites/spriteUtils'

// ── Asset imports (same PNGs the old engine uses) ──

// Character sprite sheets
import char0 from '@renderer/assets/pixel-office/characters/char_0.png'
import char1 from '@renderer/assets/pixel-office/characters/char_1.png'
import char2 from '@renderer/assets/pixel-office/characters/char_2.png'
import char3 from '@renderer/assets/pixel-office/characters/char_3.png'
import char4 from '@renderer/assets/pixel-office/characters/char_4.png'
import char5 from '@renderer/assets/pixel-office/characters/char_5.png'

export const CHAR_URLS = [char0, char1, char2, char3, char4, char5]

// ── Constants ──
const CHAR_FRAME_W = 32
const CHAR_FRAME_H = 32
const CHAR_FRAMES_PER_ROW = 7

// ── Types ──

export interface CharacterAnimKeys {
  walkDown: string
  walkUp: string
  walkRight: string
  walkLeft: string
  typeDown: string
  typeUp: string
  typeRight: string
  typeLeft: string
  readDown: string
  readUp: string
  readRight: string
  readLeft: string
  idleDown: string
  idleUp: string
  idleRight: string
  idleLeft: string
}

// ── Helpers ──

/** Render SpriteData to an HTMLCanvasElement for texture registration (requires DOM) */
function spriteDataToCanvas(sprite: SpriteData): HTMLCanvasElement {
  const { data, width, height } = spriteDataToPixelData(sprite)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(data)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// ── Character texture generation ──

interface CharacterDirectionFrames {
  down: SpriteData[]
  up: SpriteData[]
  right: SpriteData[]
}

/**
 * After assets are loaded, extract character frames and register them as Phaser textures.
 * Creates a composite sprite sheet texture for each character + hue variant.
 *
 * Each character sheet has 3 rows (down, up, right) x 7 frames:
 *   Frames 0-2: walk (idle=frame 1, walk cycle = 0,1,2,1)
 *   Frames 3-4: type
 *   Frames 5-6: read
 *
 * We also generate left frames by flipping right frames.
 * Final layout per character: 4 directions x 7 frames = 28 frames
 * Arranged as a single row sprite sheet: 28 * 16px wide, 32px tall.
 */
export async function createCharacterTextures(scene: Phaser.Scene): Promise<void> {
  const offscreen = document.createElement('canvas')
  const ctx = offscreen.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  for (let charIdx = 0; charIdx < CHAR_URLS.length; charIdx++) {
    // Guard: bail if scene was destroyed during async loading
    if (!scene.sys?.game?.renderer) {
      console.warn('[PixelOffice] Scene destroyed during character texture loading — aborting')
      break
    }

    const img = await loadImage(CHAR_URLS[charIdx])

    // Guard again after async loadImage — scene may have been destroyed while waiting
    if (!scene.sys?.game?.renderer) {
      console.warn('[PixelOffice] Scene destroyed during character texture loading — aborting')
      break
    }

    const charData: CharacterDirectionFrames = { down: [], up: [], right: [] }
    const directions: ['down', 'up', 'right'] = ['down', 'up', 'right']

    for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
      const dir = directions[dirIdx]
      const rowY = dirIdx * CHAR_FRAME_H
      for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
        const frameX = f * CHAR_FRAME_W
        charData[dir].push(imageToSpriteData(ctx, img, frameX, rowY, CHAR_FRAME_W, CHAR_FRAME_H))
      }
    }

    // Build a composite sprite sheet: 4 directions x 7 frames = 28 frames
    // Row order: down(7), up(7), right(7), left(7)
    const sheetWidth = CHAR_FRAMES_PER_ROW * CHAR_FRAME_W
    const sheetHeight = 4 * CHAR_FRAME_H // 4 directions

    const sheetCanvas = document.createElement('canvas')
    sheetCanvas.width = sheetWidth
    sheetCanvas.height = sheetHeight
    const sheetCtx = sheetCanvas.getContext('2d')!
    sheetCtx.imageSmoothingEnabled = false

    // Draw each direction row
    const allDirFrames = [
      charData.down,
      charData.up,
      charData.right,
      charData.right.map(flipSpriteH) // left = flipped right
    ]

    for (let dirIdx = 0; dirIdx < allDirFrames.length; dirIdx++) {
      const frames = allDirFrames[dirIdx]
      for (let f = 0; f < frames.length; f++) {
        const frameCanvas = spriteDataToCanvas(frames[f])
        sheetCtx.drawImage(frameCanvas, f * CHAR_FRAME_W, dirIdx * CHAR_FRAME_H)
      }
    }

    // Register as Phaser canvas texture with manual sprite sheet frames
    const textureKey = `char-${charIdx}`
    if (scene.textures.exists(textureKey)) {
      scene.textures.remove(textureKey)
    }
    const canvasTex = scene.textures.addCanvas(textureKey, sheetCanvas)
    if (canvasTex) {
      // Add frames: 4 directions x 7 frames = 28 total
      const totalFrames = 4 * CHAR_FRAMES_PER_ROW
      for (let i = 0; i < totalFrames; i++) {
        const col = i % CHAR_FRAMES_PER_ROW
        const row = Math.floor(i / CHAR_FRAMES_PER_ROW)
        canvasTex.add(i, 0, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H)
      }
    }
  }

  // Clean up
  offscreen.width = 0
  offscreen.height = 0
}

/**
 * Create a hue-shifted character texture variant.
 * Returns the texture key for the shifted version.
 */
export function createHueShiftedCharTexture(
  scene: Phaser.Scene,
  baseCharIdx: number,
  hueShift: number
): string {
  if (hueShift === 0) return `char-${baseCharIdx}`

  const variantKey = `char-${baseCharIdx}-hue${hueShift}`
  if (scene.textures.exists(variantKey)) return variantKey

  // Get the base texture's canvas source
  const baseTex = scene.textures.get(`char-${baseCharIdx}`)
  const baseSource = baseTex.getSourceImage()
  if (!baseSource || !('getContext' in baseSource)) return `char-${baseCharIdx}`

  const canvasSource = baseSource as HTMLCanvasElement
  const w = canvasSource.width
  const h = canvasSource.height
  const srcCtx = canvasSource.getContext('2d')!
  const srcData = srcCtx.getImageData(0, 0, w, h)

  // Build SpriteData from base texture using extracted pure function
  const sprite = pixelDataToSpriteData(srcData.data, w, h)

  // Apply hue shift using existing colorize module
  const shifted = adjustSprite(sprite, { h: hueShift, s: 0, b: 0, c: 0 })
  const shiftedCanvas = spriteDataToCanvas(shifted)

  // Register as canvas texture, then manually add sprite sheet frames
  const canvasTex = scene.textures.addCanvas(variantKey, shiftedCanvas)
  if (canvasTex) {
    // Add frames for sprite sheet (4 directions x 7 frames = 28 total)
    const totalFrames = 4 * CHAR_FRAMES_PER_ROW
    for (let i = 0; i < totalFrames; i++) {
      const col = i % CHAR_FRAMES_PER_ROW
      const row = Math.floor(i / CHAR_FRAMES_PER_ROW)
      canvasTex.add(i, 0, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H)
    }
  }

  return variantKey
}

// ── RPG Maker VX/Ace format (3×4 sprite sheets) ──

const RPG_FRAME_W = 32
const RPG_FRAME_H = 32
const RPG_FRAMES_PER_ROW = 3
// RPG direction rows: 0=Down, 1=Left, 2=Right, 3=Up

/**
 * Create a Phaser texture from an RPG Maker 3×4 sprite sheet (96×128 PNG).
 *
 * Builds a composite sheet matching the existing 4-direction × 7-frame layout:
 *   Row order: down, up, right, left
 *   Frame layout per row: walk[0-2], type[3-4], read[5-6]
 *   type/read frames reuse the center (idle) frame as static pose.
 */
export async function createRpgCharacterTexture(
  scene: Phaser.Scene,
  imageUrl: string,
  textureKey: string
): Promise<string> {
  if (scene.textures.exists(textureKey)) return textureKey

  const img = await loadImage(imageUrl)

  // Composite: 4 dirs × 7 frames = 28 frames, each 32×32
  const sheetWidth = CHAR_FRAMES_PER_ROW * CHAR_FRAME_W // 7 * 32 = 224
  const sheetHeight = 4 * CHAR_FRAME_H // 4 * 32 = 128

  const sheetCanvas = document.createElement('canvas')
  sheetCanvas.width = sheetWidth
  sheetCanvas.height = sheetHeight
  const ctx = sheetCanvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  // Map RPG rows → composite rows
  // Composite: 0=Down, 1=Up, 2=Right, 3=Left
  // RPG:       0=Down, 1=Left, 2=Right, 3=Up
  const rpgRowForComposite = [0, 3, 2, 1] // down←0, up←3, right←2, left←1

  for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
    const rpgRow = rpgRowForComposite[dirIdx]
    const srcY = rpgRow * RPG_FRAME_H
    const dstY = dirIdx * CHAR_FRAME_H

    // Walk frames 0-2: step-left, center, step-right
    for (let f = 0; f < RPG_FRAMES_PER_ROW; f++) {
      ctx.drawImage(
        img,
        f * RPG_FRAME_W,
        srcY,
        RPG_FRAME_W,
        RPG_FRAME_H,
        f * CHAR_FRAME_W,
        dstY,
        CHAR_FRAME_W,
        CHAR_FRAME_H
      )
    }

    // Type frames 3-4: reuse center frame (frame index 1 in RPG)
    const centerSrcX = 1 * RPG_FRAME_W
    ctx.drawImage(
      img,
      centerSrcX,
      srcY,
      RPG_FRAME_W,
      RPG_FRAME_H,
      3 * CHAR_FRAME_W,
      dstY,
      CHAR_FRAME_W,
      CHAR_FRAME_H
    )
    ctx.drawImage(
      img,
      centerSrcX,
      srcY,
      RPG_FRAME_W,
      RPG_FRAME_H,
      4 * CHAR_FRAME_W,
      dstY,
      CHAR_FRAME_W,
      CHAR_FRAME_H
    )

    // Read frames 5-6: reuse center frame
    ctx.drawImage(
      img,
      centerSrcX,
      srcY,
      RPG_FRAME_W,
      RPG_FRAME_H,
      5 * CHAR_FRAME_W,
      dstY,
      CHAR_FRAME_W,
      CHAR_FRAME_H
    )
    ctx.drawImage(
      img,
      centerSrcX,
      srcY,
      RPG_FRAME_W,
      RPG_FRAME_H,
      6 * CHAR_FRAME_W,
      dstY,
      CHAR_FRAME_W,
      CHAR_FRAME_H
    )
  }

  // Register as Phaser canvas texture with sprite sheet frames
  const canvasTex = scene.textures.addCanvas(textureKey, sheetCanvas)
  if (canvasTex) {
    const totalFrames = 4 * CHAR_FRAMES_PER_ROW
    for (let i = 0; i < totalFrames; i++) {
      const col = i % CHAR_FRAMES_PER_ROW
      const row = Math.floor(i / CHAR_FRAMES_PER_ROW)
      canvasTex.add(i, 0, col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H)
    }
  }

  return textureKey
}

/**
 * Register all character animations for a given texture key.
 *
 * Animation key naming: `{textureKey}-{action}-{direction}`
 * Actions: walk, type, read, idle
 * Directions: down, up, right, left
 *
 * Frame layout per direction row (7 frames):
 *   0,1,2 = walk frames (cycle: 0,1,2,1)
 *   3,4 = type frames (cycle: 3,4)
 *   5,6 = read frames (cycle: 5,6)
 *   idle = frame 1 (standing still)
 */
export function registerCharacterAnimations(
  scene: Phaser.Scene,
  textureKey: string
): CharacterAnimKeys {
  const dirNames = ['down', 'up', 'right', 'left'] as const
  const keys: Partial<CharacterAnimKeys> = {}

  for (let dirIdx = 0; dirIdx < dirNames.length; dirIdx++) {
    const dirName = dirNames[dirIdx]
    const rowOffset = dirIdx * CHAR_FRAMES_PER_ROW

    // Walk animation: frames 0,1,2,1 (4-frame cycle with bounce)
    const walkKey = `${textureKey}-walk-${dirName}`
    if (!scene.anims.exists(walkKey)) {
      scene.anims.create({
        key: walkKey,
        frames: [
          { key: textureKey, frame: rowOffset + 0 },
          { key: textureKey, frame: rowOffset + 1 },
          { key: textureKey, frame: rowOffset + 2 },
          { key: textureKey, frame: rowOffset + 1 }
        ],
        frameRate: 7,
        repeat: -1
      })
    }

    // Type animation: frames 3,4
    const typeKey = `${textureKey}-type-${dirName}`
    if (!scene.anims.exists(typeKey)) {
      scene.anims.create({
        key: typeKey,
        frames: [
          { key: textureKey, frame: rowOffset + 3 },
          { key: textureKey, frame: rowOffset + 4 }
        ],
        frameRate: 3,
        repeat: -1
      })
    }

    // Read animation: frames 5,6
    const readKey = `${textureKey}-read-${dirName}`
    if (!scene.anims.exists(readKey)) {
      scene.anims.create({
        key: readKey,
        frames: [
          { key: textureKey, frame: rowOffset + 5 },
          { key: textureKey, frame: rowOffset + 6 }
        ],
        frameRate: 3,
        repeat: -1
      })
    }

    // Idle: single frame (standing pose = frame 1)
    const idleKey = `${textureKey}-idle-${dirName}`
    if (!scene.anims.exists(idleKey)) {
      scene.anims.create({
        key: idleKey,
        frames: [{ key: textureKey, frame: rowOffset + 1 }],
        frameRate: 1,
        repeat: 0
      })
    }

    // Map to keys
    const capDir = dirName.charAt(0).toUpperCase() + dirName.slice(1)
    keys[`walk${capDir}` as keyof CharacterAnimKeys] = walkKey
    keys[`type${capDir}` as keyof CharacterAnimKeys] = typeKey
    keys[`read${capDir}` as keyof CharacterAnimKeys] = readKey
    keys[`idle${capDir}` as keyof CharacterAnimKeys] = idleKey
  }

  return keys as CharacterAnimKeys
}

/**
 * Get the animation key for a character's current state and direction.
 */
export function getAnimKey(
  textureKey: string,
  state: 'walk' | 'type' | 'read' | 'idle',
  direction: number
): string {
  const dirNames = ['down', 'up', 'right', 'left']
  const dirName = dirNames[direction] ?? 'down'
  return `${textureKey}-${state}-${dirName}`
}

// ── Furniture texture loading ──

/**
 * Register a SpriteData as a Phaser texture.
 * Used for furniture sprites loaded through the existing furnitureRegistry.
 */
export function registerSpriteDataTexture(
  scene: Phaser.Scene,
  key: string,
  sprite: SpriteData
): void {
  if (scene.textures.exists(key)) return
  const canvas = spriteDataToCanvas(sprite)
  scene.textures.addCanvas(key, canvas)
}

// ── Bubble textures ──

import bubblePermissionData from '../sprites/bubble-permission.json'
import bubbleWaitingData from '../sprites/bubble-waiting.json'

/**
 * Create bubble textures (permission and waiting).
 */
export function createBubbleTextures(scene: Phaser.Scene): void {
  const permSprite = resolveBubbleSprite(bubblePermissionData)
  registerSpriteDataTexture(scene, 'bubble-permission', permSprite)

  const waitSprite = resolveBubbleSprite(bubbleWaitingData)
  registerSpriteDataTexture(scene, 'bubble-waiting', waitSprite)
}

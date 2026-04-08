/**
 * spriteUtils — Pure pixel math functions extracted from PhaserSpriteLoader.
 *
 * These are testable in Node.js without any Phaser or DOM dependency.
 * Canvas-dependent functions (spriteDataToCanvas, imageToSpriteData) remain
 * in PhaserSpriteLoader as they require DOM APIs.
 */

import type { SpriteData } from '../engine/types'

/** Alpha threshold below which a pixel is treated as transparent */
const ALPHA_THRESHOLD = 2

/**
 * Convert RGBA values to a hex color string.
 * Returns '' for transparent pixels (alpha < threshold).
 * Returns '#RRGGBB' for fully opaque, '#RRGGBBAA' for semi-transparent.
 */
export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < ALPHA_THRESHOLD) return ''
  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  if (a >= 255) return hex
  return `${hex}${a.toString(16).padStart(2, '0')}`
}

/**
 * Flip SpriteData horizontally (mirror left↔right).
 * Canonical implementation — use this instead of inline copies.
 */
export function flipSpriteH(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse())
}

/**
 * Convert flat RGBA pixel data (Uint8ClampedArray from ImageData) to SpriteData.
 * Pure function — doesn't require canvas/DOM, just the raw pixel bytes.
 */
export function pixelDataToSpriteData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): SpriteData {
  const sprite: string[][] = []
  for (let y = 0; y < height; y++) {
    const row: string[] = []
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      row.push(rgbaToHex(data[i], data[i + 1], data[i + 2], data[i + 3]))
    }
    sprite.push(row)
  }
  return sprite
}

/**
 * Convert SpriteData to flat RGBA pixel data (Uint8ClampedArray).
 * Pure inverse of pixelDataToSpriteData.
 */
export function spriteDataToPixelData(sprite: SpriteData): {
  data: Uint8ClampedArray
  width: number
  height: number
} {
  const height = sprite.length
  const width = height > 0 ? sprite[0].length : 0
  const data = new Uint8ClampedArray(width * height * 4)

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const pixel = sprite[r][c]
      if (pixel === '') continue

      const i = (r * width + c) * 4
      data[i] = parseInt(pixel.slice(1, 3), 16)
      data[i + 1] = parseInt(pixel.slice(3, 5), 16)
      data[i + 2] = parseInt(pixel.slice(5, 7), 16)
      data[i + 3] = pixel.length > 7 ? parseInt(pixel.slice(7, 9), 16) : 255
    }
  }

  return { data, width, height }
}

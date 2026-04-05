/**
 * imageUtils — DOM-dependent image helpers for loading and converting images to SpriteData.
 *
 * These require browser Canvas API (HTMLImageElement, CanvasRenderingContext2D).
 * Pure pixel math lives in spriteUtils.ts; this module bridges the DOM ↔ SpriteData gap.
 */

import type { SpriteData } from '../engine/types'
import { pixelDataToSpriteData } from './spriteUtils'

/** Load an image from URL and return it */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

/** Extract pixel data from an image region as SpriteData */
export function imageToSpriteData(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number
): SpriteData {
  ctx.canvas.width = sw
  ctx.canvas.height = sh
  ctx.clearRect(0, 0, sw, sh)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  const imageData = ctx.getImageData(0, 0, sw, sh)
  return pixelDataToSpriteData(imageData.data, sw, sh)
}

/** Extract full image as SpriteData */
export function fullImageToSpriteData(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement
): SpriteData {
  return imageToSpriteData(ctx, img, 0, 0, img.width, img.height)
}

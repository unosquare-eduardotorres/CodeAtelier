// Adapted from pixel-agents: webview-ui/src/office/sprites/index.ts
// Barrel exports for sprites module.

export { getCachedSprite, getOutlineSprite } from './spriteCache'
export type { CharacterSprites, BubbleSpriteJson } from './spriteData'
export { getCharacterSprites, flipSpriteHorizontal, resolveBubbleSprite } from './spriteData'
export { rgbaToHex, flipSpriteH, pixelDataToSpriteData, spriteDataToPixelData } from './spriteUtils'
export { loadImage, imageToSpriteData, fullImageToSpriteData } from './imageUtils'

/**
 * RpgTextureLoader — Shared RPG character texture loading and hot-swap.
 *
 * Encapsulates the async pattern of loading an RPG sprite PNG,
 * converting it to a Phaser texture, registering animations,
 * and swapping the visual sprite's texture. Used by both
 * PhaserOfficeScene.addAgent and PlaceholderManager population.
 */

import Phaser from 'phaser'

import { getSpriteById } from '@renderer/assets/pixel-office/sprites'

import { createRpgCharacterTexture, registerCharacterAnimations } from './PhaserSpriteLoader'
import type { PhaserAgentManager } from './PhaserAgentManager'

/**
 * Load an RPG character texture and swap it onto an existing agent visual.
 *
 * Resolves the sprite catalog entry, loads the PNG, creates a Phaser texture,
 * registers animations, and updates the agent visual — all async.
 *
 * @param scene - The Phaser scene (for texture management)
 * @param pixelSpriteId - Sprite catalog ID (e.g. 'male-07-1')
 * @param agentManager - The agent manager holding visual references
 * @param numericId - The agent's numeric ID
 * @param resolveRpgSpriteSrc - Function to resolve sprite src to Vite URL
 */
export async function loadAndSwapRpgTexture(
  scene: Phaser.Scene,
  pixelSpriteId: string,
  agentManager: PhaserAgentManager,
  numericId: number,
  resolveRpgSpriteSrc: (src: string) => string | undefined
): Promise<void> {
  const spriteEntry = getSpriteById(pixelSpriteId)
  if (!spriteEntry) return

  const imageUrl = resolveRpgSpriteSrc(spriteEntry.src)
  if (!imageUrl) return

  const texKey = `rpg-${pixelSpriteId}`
  const key = await createRpgCharacterTexture(scene, imageUrl, texKey)

  const visual = agentManager.getAgent(numericId)
  if (visual) {
    registerCharacterAnimations(scene, key)
    visual.textureKey = key
    visual.sprite.setTexture(key, 1)
  }
}

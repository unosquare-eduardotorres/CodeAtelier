/**
 * PhaserAgentManager — Manages agent character lifecycle within the Phaser scene.
 *
 * Core lifecycle manager that delegates visual concerns to focused subsystems:
 * - AgentLabelRenderer: display name + status text labels
 * - AgentBubbleRenderer: speech bubbles (permission/waiting) + thought bubbles
 * - AgentStatusDotRenderer: active/inactive status dot sprites
 */

import Phaser from 'phaser'

import type { Character } from '../engine/types'
import { CharacterState, Direction, TILE_SIZE } from '../engine/types'
import { isReadingTool } from '../engine/characters'
import {
  createHueShiftedCharTexture,
  registerCharacterAnimations,
  getAnimKey
} from './PhaserSpriteLoader'
import { CHARACTER_SITTING_OFFSET_PX } from '../constants'
import { createAgentLabels, updateAgentLabels, updateAgentDisplayName } from './AgentLabelRenderer'
import {
  showAgentBubble,
  clearAgentBubble,
  showAgentThoughtBubble,
  hideAgentThoughtBubble
} from './AgentBubbleRenderer'
import { showAgentStatusDot } from './AgentStatusDotRenderer'

// ── Types ──

export interface AgentVisual {
  container: Phaser.GameObjects.Container
  sprite: Phaser.GameObjects.Sprite
  textureKey: string
  nameLabel: Phaser.GameObjects.Text | null
  statusLabel: Phaser.GameObjects.Text | null
  labelBg: Phaser.GameObjects.Graphics | null
  statusDot: Phaser.GameObjects.Arc | null
  statusDotTween: Phaser.Tweens.Tween | null
  bubble: Phaser.GameObjects.Image | null
  bubbleTween: Phaser.Tweens.Tween | null
  walkTween: Phaser.Tweens.TweenChain | null
  /** Current animation state to avoid re-playing same anim */
  currentAnimKey: string | null
  /** Matrix spawn/despawn effect state */
  spawnTween: Phaser.Tweens.Tween | null
  /** Outworked-style dynamic text thought bubble container */
  thoughtBubble: Phaser.GameObjects.Container | null
  /** Tween for thought bubble animation */
  thoughtBubbleTween: Phaser.Tweens.Tween | null
  /** Current thought text to avoid re-creating identical bubbles */
  currentThoughtText: string | null
}

/**
 * PhaserAgentManager — creates and manages visual representations of agents.
 */
export class PhaserAgentManager {
  private scene: Phaser.Scene
  private agents = new Map<number, AgentVisual>()
  /** Snapshot keys for dirty-check optimization in syncFromCharacters */
  private lastCharacterSnapshot = new Map<number, string>()

  constructor(scene: Phaser.Scene) {
    this.scene = scene
  }

  /** Get all agent visuals */
  getAgents(): Map<number, AgentVisual> {
    return this.agents
  }

  /** Get a specific agent visual */
  getAgent(numericId: number): AgentVisual | undefined {
    return this.agents.get(numericId)
  }

  /**
   * Create a visual agent container in the Phaser scene.
   */
  createAgent(
    numericId: number,
    spriteIndex: number,
    hueShift: number,
    startX: number,
    startY: number,
    displayName?: string,
    /** Pre-resolved RPG texture key (skips legacy char sheet when provided) */
    rpgTextureKey?: string
  ): AgentVisual {
    // Get or create texture — prefer RPG texture key when provided
    const textureKey =
      rpgTextureKey ?? createHueShiftedCharTexture(this.scene, spriteIndex, hueShift)
    registerCharacterAnimations(this.scene, textureKey)

    // Create sprite
    const sprite = this.scene.add.sprite(0, 0, textureKey, 1) // idle-down frame
    sprite.setOrigin(0.5, 1) // anchor bottom-center

    // Create container
    const container = this.scene.add.container(startX, startY, [sprite])
    container.setSize(TILE_SIZE, TILE_SIZE * 2)
    container.setData('numericId', numericId)
    container.setData('type', 'agent')

    // Name label (delegated to AgentLabelRenderer)
    let nameLabel: Phaser.GameObjects.Text | null = null
    let statusLabel: Phaser.GameObjects.Text | null = null
    let labelBg: Phaser.GameObjects.Graphics | null = null

    if (displayName) {
      const labels = createAgentLabels(this.scene, container, displayName)
      nameLabel = labels.nameLabel
      statusLabel = labels.statusLabel
      labelBg = labels.labelBg
    }

    const visual: AgentVisual = {
      container,
      sprite,
      textureKey,
      nameLabel,
      statusLabel,
      labelBg,
      statusDot: null,
      statusDotTween: null,
      bubble: null,
      bubbleTween: null,
      walkTween: null,
      currentAnimKey: null,
      spawnTween: null,
      thoughtBubble: null,
      thoughtBubbleTween: null,
      currentThoughtText: null
    }

    this.agents.set(numericId, visual)

    // Play initial idle animation
    this.playAnimation(numericId, 'idle', Direction.DOWN)

    return visual
  }

  /**
   * Remove an agent from the scene.
   * Optionally plays a despawn animation first.
   */
  removeAgent(numericId: number, animate = true): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    if (animate) {
      // Fade out + scale down
      this.cleanupTweens(visual)
      visual.spawnTween = this.scene.tweens.add({
        targets: visual.container,
        alpha: 0,
        scaleX: 0,
        scaleY: 0,
        duration: 300,
        ease: 'Power2',
        onComplete: () => {
          this.destroyVisual(numericId)
        }
      })
    } else {
      this.destroyVisual(numericId)
    }
  }

  private destroyVisual(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    this.cleanupTweens(visual)
    this.lastCharacterSnapshot.delete(numericId)
    visual.container.destroy()
    this.agents.delete(numericId)
  }

  private cleanupTweens(visual: AgentVisual): void {
    if (visual.walkTween) {
      visual.walkTween.destroy()
      visual.walkTween = null
    }
    if (visual.statusDotTween) {
      visual.statusDotTween.destroy()
      visual.statusDotTween = null
    }
    if (visual.bubbleTween) {
      visual.bubbleTween.destroy()
      visual.bubbleTween = null
    }
    if (visual.spawnTween) {
      visual.spawnTween.destroy()
      visual.spawnTween = null
    }
    if (visual.thoughtBubbleTween) {
      visual.thoughtBubbleTween.destroy()
      visual.thoughtBubbleTween = null
    }
    if (visual.thoughtBubble) {
      visual.thoughtBubble.destroy()
      visual.thoughtBubble = null
      visual.currentThoughtText = null
    }
  }

  /**
   * Play a spawn animation (scale up + fade in).
   */
  playSpawnAnimation(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    visual.container.setAlpha(0)
    visual.container.setScale(0)

    visual.spawnTween = this.scene.tweens.add({
      targets: visual.container,
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 300,
      ease: 'Back.easeOut'
    })
  }

  /**
   * Play the correct animation based on character state and direction.
   */
  playAnimation(
    numericId: number,
    state: 'walk' | 'type' | 'read' | 'idle',
    direction: number
  ): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    const animKey = getAnimKey(visual.textureKey, state, direction)
    if (visual.currentAnimKey === animKey) return

    visual.currentAnimKey = animKey
    visual.sprite.play(animKey, true)
  }

  /**
   * Update the sprite Y offset for sitting characters.
   */
  updateSittingOffset(numericId: number, isSitting: boolean): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    visual.sprite.setY(isSitting ? CHARACTER_SITTING_OFFSET_PX : 0)
  }

  /**
   * Set the agent's position directly (snap, no tween).
   */
  setPosition(numericId: number, x: number, y: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    visual.container.setPosition(x, y)
  }

  // ── Delegated to subsystems ──

  showStatusDot(numericId: number, status: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    showAgentStatusDot(this.scene, visual, status)
  }

  showBubble(numericId: number, type: 'permission' | 'waiting'): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    showAgentBubble(this.scene, visual, type)
  }

  clearBubble(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    clearAgentBubble(this.scene, visual)
  }

  showThoughtBubble(numericId: number, text: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    showAgentThoughtBubble(this.scene, visual, text)
  }

  hideThoughtBubble(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    hideAgentThoughtBubble(this.scene, visual)
  }

  updateLabels(numericId: number, isActive: boolean, state: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    updateAgentLabels(visual, isActive, state)
  }

  updateDisplayName(numericId: number, name: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    updateAgentDisplayName(visual, name)
  }

  /**
   * Sync all agent visuals from OfficeState characters.
   * Called each frame in the Phaser update loop.
   */
  syncFromCharacters(characters: Map<number, Character>): void {
    for (const [id, ch] of characters) {
      const visual = this.agents.get(id)
      if (!visual) continue

      // Skip if despawning
      if (ch.matrixEffect === 'despawn') continue

      // Dirty check: skip full sync if character state hasn't changed
      const snapshotKey = `${ch.state}:${ch.dir}:${ch.x.toFixed(1)}:${ch.y.toFixed(1)}:${ch.isActive}:${ch.currentTool}:${ch.currentThought}:${ch.bubbleType}:${ch.frame}`
      if (this.lastCharacterSnapshot.get(id) === snapshotKey) continue
      this.lastCharacterSnapshot.set(id, snapshotKey)

      // Update position from OfficeState
      visual.container.setPosition(ch.x, ch.y)

      // Update depth for z-sorting (lower y = further back)
      visual.container.setDepth(ch.y + 0.5)

      // Update animation based on character state
      const isSitting = ch.state === CharacterState.TYPE
      this.updateSittingOffset(id, isSitting)

      let animState: 'walk' | 'type' | 'read' | 'idle'
      if (ch.state === CharacterState.WALK) {
        animState = 'walk'
      } else if (ch.state === CharacterState.TYPE) {
        animState = isReadingTool(ch.currentTool) ? 'read' : 'type'
      } else {
        animState = 'idle'
      }

      this.playAnimation(id, animState, ch.dir)

      // Delegate to subsystems
      updateAgentLabels(visual, ch.isActive, ch.state)

      if (ch.isActive) {
        const dotStatus =
          ch.state === CharacterState.TYPE
            ? isReadingTool(ch.currentTool)
              ? 'reading'
              : 'working'
            : 'thinking'
        showAgentStatusDot(this.scene, visual, dotStatus)
      } else {
        showAgentStatusDot(this.scene, visual, 'idle')
      }

      if (ch.bubbleType && !visual.bubble) {
        showAgentBubble(this.scene, visual, ch.bubbleType)
      } else if (!ch.bubbleType && visual.bubble) {
        clearAgentBubble(this.scene, visual)
      }

      if (ch.currentThought) {
        showAgentThoughtBubble(this.scene, visual, ch.currentThought)
      } else if (!ch.currentThought && visual.thoughtBubble) {
        hideAgentThoughtBubble(this.scene, visual)
      }
    }
  }

  /**
   * Destroy all agent visuals (cleanup).
   */
  destroyAll(): void {
    for (const [id] of this.agents) {
      this.destroyVisual(id)
    }
    this.agents.clear()
    this.lastCharacterSnapshot.clear()
  }
}

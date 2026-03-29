/**
 * PhaserAgentManager — Manages agent character lifecycle within the Phaser scene.
 *
 * Handles creating/removing agent containers, switching animations,
 * updating status dots, thought bubbles, and display name labels.
 * Works with OfficeState as the authoritative data source.
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
import {
  CHARACTER_SITTING_OFFSET_PX,
  WALK_SPEED_PX_PER_SEC,
  BUBBLE_VERTICAL_OFFSET_PX
} from '../constants'

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

// ── Status colors ──
const STATUS_COLORS: Record<string, number> = {
  working: 0x34d399,  // green
  thinking: 0xfbbf24, // amber
  reading: 0x60a5fa,  // blue
  idle: 0x9ca3af,     // gray
  failed: 0xef4444    // red
}

/**
 * PhaserAgentManager — creates and manages visual representations of agents.
 */
export class PhaserAgentManager {
  private scene: Phaser.Scene
  private agents = new Map<number, AgentVisual>()

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
    const textureKey = rpgTextureKey ?? createHueShiftedCharTexture(this.scene, spriteIndex, hueShift)
    registerCharacterAnimations(this.scene, textureKey)

    // Create sprite
    const sprite = this.scene.add.sprite(0, 0, textureKey, 1) // idle-down frame
    sprite.setOrigin(0.5, 1) // anchor bottom-center

    // Create container
    const container = this.scene.add.container(startX, startY, [sprite])
    container.setSize(TILE_SIZE, TILE_SIZE * 2)
    container.setData('numericId', numericId)
    container.setData('type', 'agent')

    // Name label
    let nameLabel: Phaser.GameObjects.Text | null = null
    let statusLabel: Phaser.GameObjects.Text | null = null
    let labelBg: Phaser.GameObjects.Graphics | null = null

    if (displayName) {
      labelBg = this.scene.add.graphics()
      nameLabel = this.scene.add.text(0, 4, displayName, {
        fontSize: '7px',
        fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
        color: '#e5e7eb',
        align: 'center',
        fontStyle: 'bold'
      }).setOrigin(0.5, 0)

      statusLabel = this.scene.add.text(0, 13, '', {
        fontSize: '6px',
        fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
        color: '#9ca3af',
        align: 'center'
      }).setOrigin(0.5, 0)

      container.add([labelBg, nameLabel, statusLabel])
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
  playAnimation(numericId: number, state: 'walk' | 'type' | 'read' | 'idle', direction: number): void {
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

  /**
   * Walk the agent along an A* path using Phaser tweens.
   */
  walkAlongPath(
    numericId: number,
    path: Array<{ col: number; row: number }>,
    onComplete?: () => void
  ): void {
    const visual = this.agents.get(numericId)
    if (!visual || path.length === 0) return

    // Cancel existing walk tween
    if (visual.walkTween) {
      visual.walkTween.destroy()
      visual.walkTween = null
    }

    const tweenConfigs: Phaser.Types.Tweens.TweenBuilderConfig[] = []
    let prevCol = Math.floor(visual.container.x / TILE_SIZE)
    let prevRow = Math.floor(visual.container.y / TILE_SIZE)

    for (const step of path) {
      const targetX = step.col * TILE_SIZE + TILE_SIZE / 2
      const targetY = step.row * TILE_SIZE + TILE_SIZE / 2

      // Calculate direction for animation
      const dc = step.col - prevCol
      const dr = step.row - prevRow
      let dir: number = Direction.DOWN
      if (dc > 0) dir = Direction.RIGHT
      else if (dc < 0) dir = Direction.LEFT
      else if (dr < 0) dir = Direction.UP

      const duration = (TILE_SIZE / WALK_SPEED_PX_PER_SEC) * 1000 // ms per tile

      tweenConfigs.push({
        targets: visual.container,
        x: targetX,
        y: targetY,
        duration,
        ease: 'Linear',
        onStart: () => {
          this.playAnimation(numericId, 'walk', dir)
          this.updateSittingOffset(numericId, false)
        }
      })

      prevCol = step.col
      prevRow = step.row
    }

    // Create a tween chain
    const chain = this.scene.tweens.chain({
      tweens: tweenConfigs,
      onComplete: () => {
        visual.walkTween = null
        onComplete?.()
      }
    })

    visual.walkTween = chain
  }

  /**
   * Stop any active walk tween.
   */
  stopWalk(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return
    if (visual.walkTween) {
      visual.walkTween.destroy()
      visual.walkTween = null
    }
  }

  /**
   * Show or update a status dot above the agent.
   */
  showStatusDot(numericId: number, status: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    const color = STATUS_COLORS[status] ?? STATUS_COLORS.idle

    if (visual.statusDot) {
      visual.statusDot.setFillStyle(color)
      return
    }

    const dot = this.scene.add.circle(0, -20, 2, color)
    visual.container.add(dot)
    visual.statusDot = dot

    // Pulsing animation
    visual.statusDotTween = this.scene.tweens.add({
      targets: dot,
      alpha: { from: 0.4, to: 1 },
      scaleX: { from: 0.8, to: 1.3 },
      scaleY: { from: 0.8, to: 1.3 },
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    })
  }

  /**
   * Hide the status dot.
   */
  hideStatusDot(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual || !visual.statusDot) return

    if (visual.statusDotTween) {
      visual.statusDotTween.destroy()
      visual.statusDotTween = null
    }
    visual.statusDot.destroy()
    visual.statusDot = null
  }

  /**
   * Show a speech bubble (permission or waiting) above the agent.
   */
  showBubble(numericId: number, type: 'permission' | 'waiting'): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    // Remove existing bubble
    this.clearBubble(numericId)

    const textureKey = type === 'permission' ? 'bubble-permission' : 'bubble-waiting'
    if (!this.scene.textures.exists(textureKey)) return

    const bubble = this.scene.add.image(0, -BUBBLE_VERTICAL_OFFSET_PX, textureKey)
    bubble.setOrigin(0.5, 1)
    visual.container.add(bubble)
    visual.bubble = bubble

    // Gentle bounce-in animation
    bubble.setScale(0)
    visual.bubbleTween = this.scene.tweens.add({
      targets: bubble,
      scaleX: 1,
      scaleY: 1,
      duration: 200,
      ease: 'Back.easeOut'
    })
  }

  /**
   * Clear speech bubble from an agent.
   */
  clearBubble(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual || !visual.bubble) return

    if (visual.bubbleTween) {
      visual.bubbleTween.destroy()
      visual.bubbleTween = null
    }

    // Fade out before removing
    this.scene.tweens.add({
      targets: visual.bubble,
      alpha: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      duration: 150,
      onComplete: () => {
        if (visual.bubble) {
          visual.bubble.destroy()
          visual.bubble = null
        }
      }
    })
  }

  // ── Outworked-style dynamic text thought bubbles ──

  /**
   * Show a dynamic text thought bubble above the agent.
   * Renders a white rounded-rect with drop shadow, text, and tail dots.
   */
  showThoughtBubble(numericId: number, text: string): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    // Truncate long text
    const displayText = text.length > 45 ? text.slice(0, 42) + '...' : text

    // Skip if same text is already showing
    if (visual.currentThoughtText === displayText && visual.thoughtBubble) return

    // Remove existing thought bubble
    this.hideThoughtBubble(numericId)

    const bubbleContainer = this.scene.add.container(0, -BUBBLE_VERTICAL_OFFSET_PX - 4)

    // Measure text first to size the bubble
    const textObj = this.scene.add.text(0, 0, displayText, {
      fontSize: '8px',
      fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
      color: '#1f2937',
      align: 'center',
      wordWrap: { width: 120 }
    }).setOrigin(0.5, 0.5)

    const padX = 6
    const padY = 4
    const bubbleW = Math.min(140, textObj.width + padX * 2)
    const bubbleH = textObj.height + padY * 2

    // Drop shadow
    const shadow = this.scene.add.graphics()
    shadow.fillStyle(0x000000, 0.12)
    shadow.fillRoundedRect(-bubbleW / 2 + 1.5, -bubbleH + 1.5, bubbleW, bubbleH, 6)

    // Background
    const bg = this.scene.add.graphics()
    bg.fillStyle(0xffffff, 0.96)
    bg.fillRoundedRect(-bubbleW / 2, -bubbleH, bubbleW, bubbleH, 6)

    // Border
    const border = this.scene.add.graphics()
    border.lineStyle(0.5, 0xd1d5db, 0.8)
    border.strokeRoundedRect(-bubbleW / 2, -bubbleH, bubbleW, bubbleH, 6)

    // Center text in bubble
    textObj.setPosition(0, -bubbleH / 2)

    // Tail dots (3 descending circles below the bubble)
    const dots = this.scene.add.graphics()
    dots.fillStyle(0xffffff, 0.96)
    dots.fillCircle(0, 3, 3)
    dots.fillCircle(-2, 8, 2)
    dots.fillCircle(-3, 12, 1.2)
    // Dot borders
    dots.lineStyle(0.5, 0xd1d5db, 0.6)
    dots.strokeCircle(0, 3, 3)
    dots.strokeCircle(-2, 8, 2)
    dots.strokeCircle(-3, 12, 1.2)

    bubbleContainer.add([shadow, bg, border, textObj, dots])
    visual.container.add(bubbleContainer)

    visual.thoughtBubble = bubbleContainer
    visual.currentThoughtText = displayText

    // Bounce-in animation
    bubbleContainer.setScale(0)
    visual.thoughtBubbleTween = this.scene.tweens.add({
      targets: bubbleContainer,
      scaleX: 1,
      scaleY: 1,
      duration: 250,
      ease: 'Back.easeOut'
    })
  }

  /**
   * Hide the thought bubble from an agent.
   */
  hideThoughtBubble(numericId: number): void {
    const visual = this.agents.get(numericId)
    if (!visual) return

    if (visual.thoughtBubbleTween) {
      visual.thoughtBubbleTween.destroy()
      visual.thoughtBubbleTween = null
    }

    if (visual.thoughtBubble) {
      // Fade out before removing
      const bubble = visual.thoughtBubble
      this.scene.tweens.add({
        targets: bubble,
        alpha: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        duration: 150,
        onComplete: () => {
          bubble.destroy()
        }
      })
      visual.thoughtBubble = null
      visual.currentThoughtText = null
    }
  }

  /**
   * Update agent labels (name and status text).
   */
  updateLabels(numericId: number, isActive: boolean, state: string): void {
    const visual = this.agents.get(numericId)
    if (!visual || !visual.statusLabel || !visual.nameLabel || !visual.labelBg) return

    const statusText = isActive
      ? state === CharacterState.TYPE ? '⌨ Working' : '📖 Reading'
      : '💤 Idle'

    visual.statusLabel.setText(statusText)
    visual.statusLabel.setColor(isActive ? '#34d399' : '#9ca3af')

    // Update background pill
    const maxWidth = Math.max(visual.nameLabel.width, visual.statusLabel.width) + 6
    const pillH = 20
    visual.labelBg.clear()
    visual.labelBg.fillStyle(0x111827, 0.75)
    visual.labelBg.fillRoundedRect(-maxWidth / 2, 3, maxWidth, pillH, 3)
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

      // Update labels
      this.updateLabels(id, ch.isActive, ch.state)

      // Update status dot
      if (ch.isActive) {
        const dotStatus = ch.state === CharacterState.TYPE
          ? (isReadingTool(ch.currentTool) ? 'reading' : 'working')
          : 'thinking'
        this.showStatusDot(id, dotStatus)
      } else {
        this.showStatusDot(id, 'idle')
      }

      // Update bubble
      if (ch.bubbleType && !visual.bubble) {
        this.showBubble(id, ch.bubbleType)
      } else if (!ch.bubbleType && visual.bubble) {
        this.clearBubble(id)
      }

      // Update thought bubble
      if (ch.currentThought) {
        this.showThoughtBubble(id, ch.currentThought)
      } else if (!ch.currentThought && visual.thoughtBubble) {
        this.hideThoughtBubble(id)
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
  }
}

/**
 * AgentBubbleRenderer — Manages speech and thought bubbles for agents.
 *
 * Extracted from PhaserAgentManager to isolate bubble rendering concerns.
 * Handles:
 * - Permission/waiting speech bubbles (sprite-based)
 * - Dynamic text thought bubbles (Outworked-style with rounded rect)
 */

import Phaser from 'phaser'

import type { AgentVisual } from './PhaserAgentManager'
import { BUBBLE_VERTICAL_OFFSET_PX } from '../constants'

/**
 * Show a speech bubble (permission or waiting) above the agent.
 */
export function showAgentBubble(
  scene: Phaser.Scene,
  visual: AgentVisual,
  type: 'permission' | 'waiting'
): void {
  // Remove existing bubble
  clearAgentBubble(scene, visual)

  const textureKey = type === 'permission' ? 'bubble-permission' : 'bubble-waiting'
  if (!scene.textures.exists(textureKey)) return

  const bubble = scene.add.image(0, -BUBBLE_VERTICAL_OFFSET_PX, textureKey)
  bubble.setOrigin(0.5, 1)
  visual.container.add(bubble)
  visual.bubble = bubble

  // Gentle bounce-in animation
  bubble.setScale(0)
  visual.bubbleTween = scene.tweens.add({
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
export function clearAgentBubble(
  scene: Phaser.Scene,
  visual: AgentVisual
): void {
  if (!visual.bubble) return

  if (visual.bubbleTween) {
    visual.bubbleTween.destroy()
    visual.bubbleTween = null
  }

  // Fade out before removing
  scene.tweens.add({
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

/**
 * Show a dynamic text thought bubble above the agent.
 * Renders a white rounded-rect with drop shadow, text, and tail dots.
 */
export function showAgentThoughtBubble(
  scene: Phaser.Scene,
  visual: AgentVisual,
  text: string
): void {
  // Truncate long text
  const displayText = text.length > 45 ? text.slice(0, 42) + '...' : text

  // Skip if same text is already showing
  if (visual.currentThoughtText === displayText && visual.thoughtBubble) return

  // Remove existing thought bubble
  hideAgentThoughtBubble(scene, visual)

  const bubbleContainer = scene.add.container(0, -BUBBLE_VERTICAL_OFFSET_PX - 4)

  // Measure text first to size the bubble
  const textObj = scene.add.text(0, 0, displayText, {
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
  const shadow = scene.add.graphics()
  shadow.fillStyle(0x000000, 0.12)
  shadow.fillRoundedRect(-bubbleW / 2 + 1.5, -bubbleH + 1.5, bubbleW, bubbleH, 6)

  // Background
  const bg = scene.add.graphics()
  bg.fillStyle(0xffffff, 0.96)
  bg.fillRoundedRect(-bubbleW / 2, -bubbleH, bubbleW, bubbleH, 6)

  // Border
  const border = scene.add.graphics()
  border.lineStyle(0.5, 0xd1d5db, 0.8)
  border.strokeRoundedRect(-bubbleW / 2, -bubbleH, bubbleW, bubbleH, 6)

  // Center text in bubble
  textObj.setPosition(0, -bubbleH / 2)

  // Tail dots (3 descending circles below the bubble)
  const dots = scene.add.graphics()
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
  visual.thoughtBubbleTween = scene.tweens.add({
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
export function hideAgentThoughtBubble(
  scene: Phaser.Scene,
  visual: AgentVisual
): void {
  if (visual.thoughtBubbleTween) {
    visual.thoughtBubbleTween.destroy()
    visual.thoughtBubbleTween = null
  }

  if (visual.thoughtBubble) {
    // Fade out before removing
    const bubble = visual.thoughtBubble
    scene.tweens.add({
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

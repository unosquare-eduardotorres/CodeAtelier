/**
 * AgentStatusDotRenderer — Manages active/inactive status dot sprites for agents.
 *
 * Extracted from PhaserAgentManager to isolate status dot rendering concerns.
 */

import Phaser from 'phaser'

import type { AgentVisual } from './PhaserAgentManager'

// ── Status colors ──
const STATUS_COLORS: Record<string, number> = {
  working: 0x34d399,  // green
  thinking: 0xfbbf24, // amber
  reading: 0x60a5fa,  // blue
  idle: 0x9ca3af,     // gray
  failed: 0xef4444    // red
}

/**
 * Show or update a status dot above the agent.
 */
export function showAgentStatusDot(
  scene: Phaser.Scene,
  visual: AgentVisual,
  status: string
): void {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.idle

  if (visual.statusDot) {
    visual.statusDot.setFillStyle(color)
    return
  }

  const dot = scene.add.circle(0, -20, 2, color)
  visual.container.add(dot)
  visual.statusDot = dot

  // Pulsing animation
  visual.statusDotTween = scene.tweens.add({
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

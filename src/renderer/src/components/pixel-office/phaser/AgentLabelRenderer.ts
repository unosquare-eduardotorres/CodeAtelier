/**
 * AgentLabelRenderer — Manages display name labels and status text for agents.
 *
 * Extracted from PhaserAgentManager to isolate label rendering concerns.
 * Each agent can have a name label, status label, and background pill.
 */

import Phaser from 'phaser'

import type { AgentVisual } from './PhaserAgentManager'
import { CharacterState } from '../engine/types'

/**
 * Create label elements (name, status, background pill) and add them to the container.
 * Returns the created elements for inclusion in AgentVisual.
 */
export function createAgentLabels(
  scene: Phaser.Scene,
  container: Phaser.GameObjects.Container,
  displayName: string
): {
  nameLabel: Phaser.GameObjects.Text
  statusLabel: Phaser.GameObjects.Text
  labelBg: Phaser.GameObjects.Graphics
} {
  const labelBg = scene.add.graphics()
  const nameLabel = scene.add
    .text(0, 4, displayName, {
      fontSize: '7px',
      fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
      color: '#e5e7eb',
      align: 'center',
      fontStyle: 'bold'
    })
    .setOrigin(0.5, 0)

  const statusLabel = scene.add
    .text(0, 13, '', {
      fontSize: '6px',
      fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
      color: '#9ca3af',
      align: 'center'
    })
    .setOrigin(0.5, 0)

  container.add([labelBg, nameLabel, statusLabel])

  return { nameLabel, statusLabel, labelBg }
}

/**
 * Update agent labels (name and status text) based on character state.
 */
export function updateAgentLabels(visual: AgentVisual, isActive: boolean, state: string): void {
  if (!visual.statusLabel || !visual.nameLabel || !visual.labelBg) return

  const statusText = isActive
    ? state === CharacterState.TYPE
      ? '⌨ Working'
      : '📖 Reading'
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
 * Update only the display name text.
 */
export function updateAgentDisplayName(visual: AgentVisual, name: string): void {
  if (!visual.nameLabel) return
  visual.nameLabel.setText(name)

  if (visual.labelBg && visual.statusLabel) {
    const maxWidth = Math.max(visual.nameLabel.width, visual.statusLabel.width) + 6
    visual.labelBg.clear()
    visual.labelBg.fillStyle(0x111827, 0.75)
    visual.labelBg.fillRoundedRect(-maxWidth / 2, 3, maxWidth, 20, 3)
  }
}

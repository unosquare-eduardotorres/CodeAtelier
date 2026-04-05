/**
 * DustParticleSystem — Ambient floating dust motes for the pixel office.
 *
 * Extracted from PhaserOfficeScene to reduce god-class complexity.
 * Manages a pool of warm amber/parchment-colored particles that drift
 * across the office with fade-in/out lifecycle.
 */

import Phaser from 'phaser'

import { TILE_SIZE } from '../engine/types'
import type { OfficeLayout } from '../engine/types'

interface DustMote {
  x: number
  y: number
  vx: number
  vy: number
  alpha: number
  life: number
  maxLife: number
}

const INITIAL_MOTE_COUNT = 20
const DUST_COLORS = [0xd4a855, 0xc89640, 0xe8c070, 0xb88830]

export class DustParticleSystem {
  private graphics: Phaser.GameObjects.Graphics | null = null
  private motes: DustMote[] = []

  /**
   * Initialize the dust particle system. Call once during scene create().
   */
  init(scene: Phaser.Scene, layout: OfficeLayout | undefined): void {
    this.graphics = scene.add.graphics()
    this.graphics.setDepth(500)

    if (!layout) return

    const worldW = layout.cols * TILE_SIZE
    const worldH = layout.rows * TILE_SIZE

    for (let i = 0; i < INITIAL_MOTE_COUNT; i++) {
      this.spawnMote(worldW, worldH)
    }
  }

  /**
   * Update all dust particles. Call every frame with delta time in seconds.
   */
  update(dt: number, layout: OfficeLayout | undefined): void {
    if (!this.graphics || !layout) return

    const worldW = layout.cols * TILE_SIZE
    const worldH = layout.rows * TILE_SIZE

    this.graphics.clear()

    for (let i = this.motes.length - 1; i >= 0; i--) {
      const mote = this.motes[i]
      mote.x += mote.vx * dt
      mote.y += mote.vy * dt
      mote.life += dt

      // Fade in and out
      const progress = mote.life / mote.maxLife
      let alpha = mote.alpha
      if (progress < 0.2) {
        alpha *= progress / 0.2
      } else if (progress > 0.8) {
        alpha *= (1 - progress) / 0.2
      }

      if (mote.life >= mote.maxLife) {
        // Swap-and-pop: O(1) removal instead of O(n) splice
        this.motes[i] = this.motes[this.motes.length - 1]
        this.motes.pop()
        this.spawnMote(worldW, worldH)
        continue
      }

      // Draw dust mote — warm amber/parchment tones (floating embers)
      const dustColor = DUST_COLORS[i % DUST_COLORS.length]
      this.graphics.fillStyle(dustColor, alpha)
      this.graphics.fillCircle(mote.x, mote.y, 0.5)
    }
  }

  /**
   * Destroy the particle system and clean up resources.
   */
  destroy(): void {
    this.graphics?.destroy()
    this.graphics = null
    this.motes = []
  }

  private spawnMote(worldW: number, worldH: number): void {
    this.motes.push({
      x: Math.random() * worldW,
      y: Math.random() * worldH,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 1.5 - 1, // Slight upward drift
      alpha: Math.random() * 0.3,
      life: 0,
      maxLife: 3 + Math.random() * 4
    })
  }
}

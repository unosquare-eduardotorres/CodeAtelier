/** Shared utility functions for the pixel-office engine */

/** Random float in range [min, max) */
export function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Random integer in range [min, max] (inclusive) */
export function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

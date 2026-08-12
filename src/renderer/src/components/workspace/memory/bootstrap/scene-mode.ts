/**
 * The decision behind what BrainIngestScene renders, kept out of the component
 * so it can be tested without a DOM or a GPU.
 *
 * The distinction that matters is the second one: "no WebGL" and "the user
 * asked for less motion" used to collapse into the same dead CSS rectangle.
 * They are different problems. prefers-reduced-motion is about vestibular
 * *motion*, not about hiding content — so it still gets the scene, drawn once
 * and never animated. Only a refused WebGL context falls back to CSS.
 */

export type SceneMode =
  /** WebGL scene with the rAF loop running. */
  | 'animated'
  /** WebGL scene rendered exactly once — no rotation, particles or pulse. */
  | 'static'
  /** No WebGL context: CSS only. */
  | 'fallback'

export function resolveSceneMode(webglOk: boolean, reducedMotion: boolean): SceneMode {
  if (!webglOk) return 'fallback'
  return reducedMotion ? 'static' : 'animated'
}

import { Scene, WebGLRenderer, Mesh, Points, Line } from 'three'

/** Check if user prefers reduced motion */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Check if running in E2E test environment */
export function isE2ETesting(): boolean {
  return (
    !!(window as unknown as Record<string, unknown>).__E2E_TESTING__ ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test')
  )
}

// ── User-initiated transition gate ──
let _userInitiated = false

/** Mark the next workspace open as user-initiated (eligible for animation) */
export function markUserInitiatedOpen(): void {
  _userInitiated = true
}

/** Consume and reset the user-initiated flag */
export function consumeUserInitiated(): boolean {
  const v = _userInitiated
  _userInitiated = false
  return v
}

/** Dispose all Three.js objects in a scene (geometries + materials) */
export function disposeScene(scene: Scene): void {
  scene.traverse((object) => {
    if (object instanceof Mesh || object instanceof Points || object instanceof Line) {
      object.geometry?.dispose()
      const mat = object.material
      if (Array.isArray(mat)) {
        mat.forEach((m) => m.dispose())
      } else if (mat) {
        mat.dispose()
      }
    }
  })
}

/** Full renderer teardown sequence */
export function teardownRenderer(
  renderer: WebGLRenderer | null,
  scene: Scene | null,
  container: HTMLElement | null,
  animationId: number | null
): void {
  // 1. Stop animation loop FIRST
  if (animationId !== null) cancelAnimationFrame(animationId)
  // 2. Dispose scene objects
  if (scene) disposeScene(scene)
  // 3. Dispose renderer (releases WebGL context)
  if (renderer) {
    renderer.dispose()
    const canvas = renderer.domElement
    if (container?.contains(canvas)) container.removeChild(canvas)
  }
}

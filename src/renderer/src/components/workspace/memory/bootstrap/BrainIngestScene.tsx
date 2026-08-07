/**
 * BrainIngestScene — ambient "neural intake" visual for an active ingestion.
 *
 * three.js rather than Remotion: Remotion is a video renderer (React → MP4),
 * which is the wrong tool for a live view. `three` is already a direct
 * dependency (react-force-graph-3d), so this costs no new packages.
 *
 * Deliberately decorative and cheap. It sits *beside* the numbers, never
 * instead of them — the data panel is the actual product.
 *
 * Performance guardrails (Electron shares a GPU process with the whole app):
 *  - one renderer, one InstancedMesh for particles → a single draw call
 *  - pixel ratio capped at 1.5
 *  - rAF loop stops on unmount, on `document.hidden`, and when scrolled out of
 *    view via IntersectionObserver
 *  - every geometry/material/renderer disposed on unmount
 *  - honours prefers-reduced-motion by drawing the scene *once* — see
 *    ./scene-mode — and falls back to CSS only if WebGL is refused
 */

import { useEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import * as THREE from 'three'
import { resolveSceneMode } from './scene-mode'

const PARTICLE_COUNT = 90
const LATTICE_POINTS = 1800

interface BrainIngestSceneProps {
  /** Drives emission rate and core brightness. */
  itemsPerMinute: number | null
  /** A dim, motionless core reads as "stopped" at a glance. */
  paused: boolean
  /** User opt-in that overrides a machine-level prefers-reduced-motion. */
  forceAnimation?: boolean
  className?: string
}

export default function BrainIngestScene({
  itemsPerMinute,
  paused,
  forceAnimation = false,
  className = ''
}: BrainIngestSceneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // Whether a context can be created never changes for the life of the window.
  const [webglOk] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      const probe = document.createElement('canvas')
      return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'))
    } catch {
      return false
    }
  })

  // The motion preference does change — Windows exposes it under Accessibility
  // and under "Adjust for best performance". Reading it once meant an app
  // restart was needed before a toggle took effect.
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  )
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mql) return undefined
    const onChange = (e: MediaQueryListEvent): void => setReducedMotion(e.matches)
    // No initial read here — the useState initialiser above already took one
    // this same tick, and a sync setState in an effect cascades a render.
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const mode = resolveSceneMode(webglOk, reducedMotion && !forceAnimation)

  // Latest props without re-running the effect (which would rebuild the scene).
  const stateRef = useRef({ itemsPerMinute, paused })
  useEffect(() => {
    stateRef.current = { itemsPerMinute, paused }
  }, [itemsPerMinute, paused])

  useEffect(() => {
    const container = containerRef.current
    if (!container || mode === 'fallback') return undefined

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false })
    } catch {
      return undefined
    }

    const width = container.clientWidth || 320
    const height = container.clientHeight || 180

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    // `true` (update the CSS size) is load-bearing: with `false` the canvas
    // lays out at its attribute size — width × pixelRatio CSS px — so on any
    // HiDPI display it overflowed its 180px box and showed a cropped, zoomed
    // slice of the scene.
    renderer.setSize(width, height, true)
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100)
    camera.position.set(0, 0, 6)

    // ── Lattice: a slowly-rotating point cloud standing in for the brain ──
    const latticePositions = new Float32Array(LATTICE_POINTS * 3)
    for (let i = 0; i < LATTICE_POINTS; i++) {
      // Fibonacci sphere, jittered so it reads organic rather than gridded.
      const t = i / LATTICE_POINTS
      const inclination = Math.acos(1 - 2 * t)
      const azimuth = Math.PI * (1 + Math.sqrt(5)) * i
      const r = 2 + (Math.random() - 0.5) * 0.25
      latticePositions[i * 3] = r * Math.sin(inclination) * Math.cos(azimuth)
      latticePositions[i * 3 + 1] = r * Math.sin(inclination) * Math.sin(azimuth) * 0.8
      latticePositions[i * 3 + 2] = r * Math.cos(inclination)
    }
    const latticeGeom = new THREE.BufferGeometry()
    latticeGeom.setAttribute('position', new THREE.BufferAttribute(latticePositions, 3))
    const latticeMat = new THREE.PointsMaterial({
      color: 0x2dd4bf,
      size: 0.035,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    })
    const lattice = new THREE.Points(latticeGeom, latticeMat)
    scene.add(lattice)

    // ── Core ──
    const coreGeom = new THREE.IcosahedronGeometry(0.55, 2)
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0.35,
      wireframe: true
    })
    const core = new THREE.Mesh(coreGeom, coreMat)
    scene.add(core)

    // ── Particles: one InstancedMesh, one draw call ──
    const particleGeom = new THREE.SphereGeometry(0.05, 6, 6)
    const particleMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 })
    const particles = new THREE.InstancedMesh(particleGeom, particleMat, PARTICLE_COUNT)
    particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    particles.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(PARTICLE_COUNT * 3),
      3
    )
    scene.add(particles)

    // Memory-category palette, matching CategoryBadge.
    const PALETTE = [
      new THREE.Color(0x60a5fa), // decision   — blue
      new THREE.Color(0x34d399), // convention — green
      new THREE.Color(0xf87171), // gotcha     — red
      new THREE.Color(0xa78bfa), // preference — purple
      new THREE.Color(0x22d3ee) // reference  — cyan
    ]

    interface Particle {
      start: THREE.Vector3
      t: number
      speed: number
      active: boolean
    }

    const pool: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
      start: new THREE.Vector3(),
      t: 0,
      speed: 0.4,
      active: false
    }))

    const dummy = new THREE.Object3D()

    // Instance matrices start out as the identity, which would stack all 90
    // spheres at the origin. Anything that renders without running the loop
    // has to park them first.
    const parkParticles = (): void => {
      dummy.position.set(0, 0, -999)
      dummy.scale.setScalar(0.001)
      dummy.updateMatrix()
      for (let i = 0; i < PARTICLE_COUNT; i++) particles.setMatrixAt(i, dummy.matrix)
      particles.instanceMatrix.needsUpdate = true
    }

    const spawn = (p: Particle, index: number): void => {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 4.5
      p.start.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      )
      p.t = 0
      p.speed = 0.35 + Math.random() * 0.45
      p.active = true
      const color = PALETTE[index % PALETTE.length]
      particles.instanceColor!.setXYZ(index, color.r, color.g, color.b)
      particles.instanceColor!.needsUpdate = true
    }

    // ── Loop ──
    let rafId = 0
    let running = false
    let lastTime = performance.now()
    let spawnAccumulator = 0

    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now

      const { itemsPerMinute: rate, paused: isPaused } = stateRef.current
      const intensity = isPaused ? 0 : Math.min(1, (rate ?? 6) / 30)

      lattice.rotation.y += dt * (0.05 + intensity * 0.25)
      core.rotation.x += dt * (0.1 + intensity * 0.3)
      core.rotation.y -= dt * (0.08 + intensity * 0.2)

      const pulse = isPaused ? 0.12 : 0.3 + Math.sin(now / 400) * 0.1 * intensity
      coreMat.opacity = pulse
      core.scale.setScalar(1 + (isPaused ? 0 : Math.sin(now / 500) * 0.05))
      latticeMat.opacity = isPaused ? 0.18 : 0.5

      if (!isPaused) {
        spawnAccumulator += dt * (2 + intensity * 12)
        while (spawnAccumulator >= 1) {
          spawnAccumulator -= 1
          const idle = pool.findIndex((p) => !p.active)
          if (idle >= 0) spawn(pool[idle], idle)
        }
      }

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = pool[i]
        if (!p.active) {
          dummy.position.set(0, 0, -999) // park offscreen
          dummy.scale.setScalar(0.001)
        } else {
          p.t += dt * p.speed
          if (p.t >= 1) {
            p.active = false
            continue
          }
          // Ease toward the core and shrink on arrival.
          const eased = p.t * p.t
          dummy.position.copy(p.start).multiplyScalar(1 - eased)
          dummy.scale.setScalar(1 - p.t * 0.6)
        }
        dummy.updateMatrix()
        particles.setMatrixAt(i, dummy.matrix)
      }
      particles.instanceMatrix.needsUpdate = true

      renderer.render(scene, camera)
      rafId = requestAnimationFrame(frame)
    }

    const start = (): void => {
      if (running) return
      running = true
      lastTime = performance.now()
      rafId = requestAnimationFrame(frame)
    }
    const stop = (): void => {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
    }

    const onResize = (): void => {
      const w = container.clientWidth || width
      const h = container.clientHeight || height
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, true)
      if (mode === 'static') renderer.render(scene, camera)
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(container)

    const disposeScene = (): void => {
      latticeGeom.dispose()
      latticeMat.dispose()
      coreGeom.dispose()
      coreMat.dispose()
      particleGeom.dispose()
      particleMat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }

    // ── Reduced motion: the same scene, drawn once and left alone ──
    // The preference is about motion, not about hiding content, so the lattice
    // and core still render — just at a fixed angle with no loop, no particle
    // flight and no pulse.
    if (mode === 'static') {
      parkParticles()
      lattice.rotation.y = 0.6
      core.rotation.x = 0.4
      renderer.render(scene, camera)
      return () => {
        resizeObserver.disconnect()
        disposeScene()
      }
    }

    // Only animate while actually on screen and in a visible window.
    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting && !document.hidden ? start() : stop()),
      { threshold: 0.05 }
    )
    observer.observe(container)

    const onVisibility = (): void => {
      if (document.hidden) stop()
      else if (container.isConnected) start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      observer.disconnect()
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      disposeScene()
    }
  }, [mode])

  if (mode === 'fallback') {
    // No WebGL context at all. Legible on purpose: the old 10%-opacity
    // gradient was indistinguishable from an empty broken box.
    return (
      <div
        className={`rounded-lg border border-teal/20 bg-gradient-to-br from-teal/20 via-surface-overlay to-purple-500/20 flex items-center justify-center ${className}`}
        aria-hidden="true"
      >
        <Brain className="w-8 h-8 text-teal/50" />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`rounded-lg overflow-hidden bg-surface-overlay/30 ${className}`}
      aria-hidden="true"
    />
  )
}

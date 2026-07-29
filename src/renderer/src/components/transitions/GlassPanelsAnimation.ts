import {
  Scene, PerspectiveCamera, WebGLRenderer, BoxGeometry,
  MeshPhysicalMaterial, Mesh, AmbientLight, DirectionalLight,
  Vector3, EdgesGeometry, LineSegments, LineBasicMaterial,
  BufferGeometry, Float32BufferAttribute, PointsMaterial,
  Points, AdditiveBlending, Color
} from 'three'
import { COLORS, easeOut, GLASS_DURATION } from './transition-constants'
import { teardownRenderer } from './transition-utils'

interface GlassPanelsConfig {
  container: HTMLElement
  onComplete: () => void
  onError: () => void
}

export class GlassPanelsAnimation {
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: PerspectiveCamera | null = null
  private animationId: number | null = null
  private mounted = true
  private startTime = 0
  private config: GlassPanelsConfig
  private resizeHandler: (() => void) | null = null
  private contextLostHandler: ((e: Event) => void) | null = null

  constructor(config: GlassPanelsConfig) {
    this.config = config
    this.init()
  }

  private init(): void {
    const { container } = this.config
    const w = container.clientWidth
    const h = container.clientHeight

    // ── Renderer ──
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    // ── WebGL context lost handler ──
    this.contextLostHandler = (e: Event) => {
      e.preventDefault()
      this.config.onError()
    }
    renderer.domElement.addEventListener('webglcontextlost', this.contextLostHandler)

    // ── Scene ──
    const scene = new Scene()
    scene.background = new Color(COLORS.obsidian)
    this.scene = scene

    // ── Camera ──
    const camera = new PerspectiveCamera(50, w / h, 0.1, 100)
    camera.position.set(0, 0, 8)
    this.camera = camera

    // ── Lighting (warm gold) ──
    scene.add(new AmbientLight(COLORS.atelierGold, 0.3))
    const dir = new DirectionalLight(COLORS.brightGold, 1.2)
    dir.position.set(3, 4, 5)
    scene.add(dir)

    // ── Three glass panels (sidebar, chat area, status bar) ──
    this.createPanels(scene)

    // ── Gold dust particles (additive blending, no bloom needed) ──
    this.createDustParticles(scene)

    // ── Resize handler ──
    this.resizeHandler = () => {
      if (!this.renderer || !this.camera) return
      const rw = this.config.container.clientWidth
      const rh = this.config.container.clientHeight
      this.renderer.setSize(rw, rh)
      this.camera.aspect = rw / rh
      this.camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', this.resizeHandler)

    // ── Start animation loop ──
    this.startTime = performance.now()
    this.animate()
  }

  private createPanels(scene: Scene): void {
    const panelConfigs = [
      { w: 1.8, h: 4, target: [-3.2, 0, 0] as const, rot: [0, 0.12, 0] as const, color: COLORS.surfaceRaised },
      { w: 5, h: 3.2, target: [1.2, 0.5, -0.5] as const, rot: [0, -0.08, 0] as const, color: COLORS.surfaceBase },
      { w: 7.5, h: 0.4, target: [0, -2.4, 0.3] as const, rot: [0.06, 0, 0] as const, color: COLORS.surfaceOverlay },
    ]

    panelConfigs.forEach((cfg) => {
      const geo = new BoxGeometry(cfg.w, cfg.h, 0.04)
      const mat = new MeshPhysicalMaterial({
        color: cfg.color,
        metalness: 0.1,
        roughness: 0.6,
        transparent: true,
        opacity: 0,
        transmission: 0.3,
      })
      const mesh = new Mesh(geo, mat)

      // Gold edge lines
      const edges = new EdgesGeometry(geo)
      const edgeMat = new LineBasicMaterial({ color: COLORS.atelierGold, transparent: true, opacity: 0 })
      mesh.add(new LineSegments(edges, edgeMat))

      // Random scattered start position
      const scatter = 5 + Math.random() * 3
      mesh.position.set(
        cfg.target[0] + (Math.random() - 0.5) * scatter,
        cfg.target[1] + (Math.random() - 0.5) * scatter * 0.6,
        cfg.target[2] - 3 - Math.random() * 3
      )
      mesh.rotation.set(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.3
      )

      mesh.userData = {
        targetPos: new Vector3(...cfg.target),
        targetRot: { x: cfg.rot[0], y: cfg.rot[1], z: cfg.rot[2] },
        startPos: mesh.position.clone(),
        startRot: { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z },
      }

      scene.add(mesh)
    })
  }

  private createDustParticles(scene: Scene): void {
    const count = 200
    const geo = new BufferGeometry()
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 12
      positions[i * 3 + 1] = (Math.random() - 0.5) * 8
      positions[i * 3 + 2] = (Math.random() - 0.5) * 8
    }
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const mat = new PointsMaterial({
      color: COLORS.atelierGold,
      size: 0.04,
      transparent: true,
      opacity: 0.4,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    scene.add(new Points(geo, mat))
  }

  private animate = (): void => {
    if (!this.mounted || !this.renderer || !this.scene || !this.camera) return

    const elapsed = performance.now() - this.startTime
    const t = Math.min(elapsed / GLASS_DURATION, 1)

    // ── Animate panels with staggered iOS spring easing ──
    const panels = this.scene.children.filter((c): c is Mesh => c instanceof Mesh)
    panels.forEach((mesh, i) => {
      if (!mesh.userData.targetPos) return

      const delay = i * 0.12
      const pt = Math.max(0, Math.min(1, (t - delay) / (1 - delay * 0.4)))
      const s = easeOut(pt)

      // Position lerp
      mesh.position.lerpVectors(mesh.userData.startPos as Vector3, mesh.userData.targetPos as Vector3, s)

      // Rotation lerp
      const sr = mesh.userData.startRot as { x: number; y: number; z: number }
      const tr = mesh.userData.targetRot as { x: number; y: number; z: number }
      mesh.rotation.x = sr.x * (1 - s) + tr.x * s
      mesh.rotation.y = sr.y * (1 - s) + tr.y * s
      mesh.rotation.z = sr.z * (1 - s) + tr.z * s

      // Opacity reveal
      const mat = mesh.material as MeshPhysicalMaterial
      mat.opacity = 0.3 + s * 0.5

      // Edge glow
      const edgeLine = mesh.children[0] as LineSegments | undefined
      if (edgeLine) {
        (edgeLine.material as LineBasicMaterial).opacity = 0.15 + s * 0.45
      }
    })

    // ── Camera push forward ──
    this.camera.position.z = 8 - easeOut(t) * 1.5
    this.camera.position.y = Math.sin(elapsed * 0.001) * 0.12

    // ── Fade out in final 20% ──
    if (t > 0.8) {
      const fadeT = (t - 0.8) / 0.2
      this.renderer.domElement.style.opacity = String(1 - fadeT)
    }

    this.renderer.render(this.scene, this.camera)

    if (t >= 1) {
      this.config.onComplete()
      return
    }

    this.animationId = requestAnimationFrame(this.animate)
  }

  dispose(): void {
    this.mounted = false
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
    if (this.contextLostHandler && this.renderer) {
      this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLostHandler)
      this.contextLostHandler = null
    }
    teardownRenderer(this.renderer, this.scene, this.config.container, this.animationId)
    this.renderer = null
    this.scene = null
    this.camera = null
    this.animationId = null
  }
}

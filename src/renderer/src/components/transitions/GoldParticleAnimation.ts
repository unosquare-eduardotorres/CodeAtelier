import {
  Scene, PerspectiveCamera, WebGLRenderer, BufferGeometry,
  Float32BufferAttribute, ShaderMaterial, Points, Color, NormalBlending
} from 'three'
import {
  SCENE_BG, easeOutCubic, PARTICLE_DURATION,
  PARTICLE_COUNT_HIGH, PARTICLE_COUNT_LOW, FRAME_TIME_THRESHOLD
} from './transition-constants'
import { teardownRenderer } from './transition-utils'

// ── Gold palette for vertex colors (monochromatic warm gold) ──
const GOLD_PALETTE: readonly [number, number, number][] = [
  [0.85, 0.72, 0.45],  // warmGold
  [0.78, 0.65, 0.38],  // deepGold
  [0.92, 0.80, 0.55],  // lightGold
  [0.70, 0.58, 0.32],  // antiqueGold
]

// ── Custom shaders ──
const VERTEX_SHADER = /* glsl */ `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uOpacity;
  varying float vOpacity;
  varying vec3 vColor;
  void main() {
    float twinkle = sin(uTime * aSpeed + aPhase) * 0.25 + 0.75;
    vOpacity = twinkle * uOpacity;
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying float vOpacity;
  varying vec3 vColor;
  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, dist) * vOpacity;
    gl_FragColor = vec4(vColor, alpha);
  }
`

interface GoldParticleConfig {
  container: HTMLElement
  workspaceName: string
  onComplete: () => void
  onError: () => void
}

export class GoldParticleAnimation {
  private renderer: WebGLRenderer | null = null
  private scene: Scene | null = null
  private camera: PerspectiveCamera | null = null
  private animationId: number | null = null
  private mounted = true
  private startTime = 0
  private config: GoldParticleConfig
  private resizeHandler: (() => void) | null = null
  private contextLostHandler: ((e: Event) => void) | null = null
  private targets!: Float32Array
  private speeds!: Float32Array
  private geo!: BufferGeometry
  private mat!: ShaderMaterial
  private particleCount: number

  constructor(config: GoldParticleConfig) {
    this.config = config
    this.particleCount = PARTICLE_COUNT_HIGH
    this.init()
  }

  private init(): void {
    const { container, workspaceName } = this.config
    const w = container.clientWidth
    const h = container.clientHeight

    // ── Renderer ──
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    this.contextLostHandler = (e: Event) => {
      e.preventDefault()
      this.config.onError()
    }
    renderer.domElement.addEventListener('webglcontextlost', this.contextLostHandler)

    // ── Scene ──
    const scene = new Scene()
    scene.background = new Color(SCENE_BG)
    this.scene = scene

    const camera = new PerspectiveCamera(50, w / h, 0.1, 100)
    camera.position.z = 5
    this.camera = camera

    // ── Sample text target positions from offscreen canvas ──
    const textTargets = this.sampleTextPositions(workspaceName)

    // ── Build particle system ──
    this.buildParticles(textTargets)

    // ── Adaptive quality: check first-frame time ──
    const frameStart = performance.now()
    renderer.render(scene, camera)
    const frameTime = performance.now() - frameStart
    if (frameTime > FRAME_TIME_THRESHOLD) {
      // Rebuild with fewer particles — dispose the old Points to free GPU memory
      this.particleCount = PARTICLE_COUNT_LOW
      if (scene.children.length > 0) {
        const old = scene.children[0] as Points
        scene.remove(old)
        old.geometry?.dispose()
        ;(old.material as ShaderMaterial)?.dispose()
      }
      this.buildParticles(textTargets)
    }

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

    this.startTime = performance.now()
    this.animate()
  }

  private sampleTextPositions(name: string): [number, number, number][] {
    // Truncate long names
    const displayName = name.length > 20 ? name.slice(0, 18) + '…' : name
    // Scale font size based on name length
    const fontSize = Math.max(36, 60 - displayName.length)

    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 200
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 800, 200)
    ctx.font = `600 ${fontSize}px Georgia, serif`
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(displayName, 400, 100)

    const imgData = ctx.getImageData(0, 0, 800, 200)
    const positions: [number, number, number][] = []
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 800; x += 1) {
        if (imgData.data[(y * 800 + x) * 4] > 128) {
          positions.push([(x - 400) / 100, (100 - y) / 100, 0])
        }
      }
    }

    // Cap text positions to 80% of particle budget so background ring particles
    // still get allocated. Without this, names ≥6 chars produce more text
    // positions than PARTICLE_COUNT_HIGH (1500), leaving zero ring particles
    // and truncating the bottom of letters (scan is top-to-bottom).
    const maxTextParticles = Math.floor(this.particleCount * 0.9)
    if (positions.length > maxTextParticles) {
      // Fisher-Yates shuffle then truncate — preserves even spatial distribution
      for (let i = positions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[positions[i], positions[j]] = [positions[j], positions[i]]
      }
      positions.length = maxTextParticles
    }

    return positions
  }

  private buildParticles(textTargets: [number, number, number][]): void {
    const count = this.particleCount
    const positions = new Float32Array(count * 3)
    const targets = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const phases = new Float32Array(count)
    const speeds = new Float32Array(count)
    const sizes = new Float32Array(count)

    // Compute text extent so background ring clears the text with margin
    const textMaxX = textTargets.reduce((max, t) => Math.max(max, Math.abs(t[0])), 0)
    const ringInner = Math.max(2.5, textMaxX + 0.8)  // at least 0.8 units clear of text edge

    for (let i = 0; i < count; i++) {
      // Scattered start positions (ring around center)
      const angle = Math.random() * Math.PI * 2
      const radius = 3 + Math.random() * 4
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = Math.sin(angle) * (radius * 0.6)
      positions[i * 3 + 2] = (Math.random() - 0.5) * 4

      // Target: text position or decorative ring around text
      if (i < textTargets.length) {
        targets[i * 3] = textTargets[i][0]
        targets[i * 3 + 1] = textTargets[i][1]
        targets[i * 3 + 2] = textTargets[i][2]
      } else {
        const bgAngle = Math.random() * Math.PI * 2
        const bgRadius = ringInner + Math.random() * 2.5  // ring clears text
        targets[i * 3] = Math.cos(bgAngle) * bgRadius
        targets[i * 3 + 1] = Math.sin(bgAngle) * (bgRadius * 0.5)
        targets[i * 3 + 2] = (Math.random() - 0.5) * 2
      }

      // Color from gold palette (monochromatic warm gold)
      const isText = i < textTargets.length
      const c = GOLD_PALETTE[Math.floor(Math.random() * GOLD_PALETTE.length)]
      const dim = isText ? 1.0 : 0.5
      colors[i * 3] = c[0] * dim
      colors[i * 3 + 1] = c[1] * dim
      colors[i * 3 + 2] = c[2] * dim

      phases[i] = Math.random() * Math.PI * 2
      speeds[i] = 0.5 + Math.random() * 1.5
      sizes[i] = isText
        ? 0.06 + Math.random() * 0.06  // text: 0.06–0.12 (~2–5px on screen) — fine dust
        : 0.04 + Math.random() * 0.06  // background: 0.04–0.10 (~2–4px)
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
    geo.setAttribute('aPhase', new Float32BufferAttribute(phases, 1))
    geo.setAttribute('aSpeed', new Float32BufferAttribute(speeds, 1))
    geo.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))

    const mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.85 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    })

    this.scene!.add(new Points(geo, mat))
    this.targets = targets
    this.speeds = speeds
    this.geo = geo
    this.mat = mat
  }

  private animate = (): void => {
    if (!this.mounted || !this.renderer || !this.scene || !this.camera) return

    const elapsed = performance.now() - this.startTime
    const t = Math.min(elapsed / PARTICLE_DURATION, 1)
    const posAttr = this.geo.attributes.position as { array: Float32Array; needsUpdate: boolean }
    const count = this.particleCount

    this.mat.uniforms.uTime.value = elapsed / 1000

    // Phase 1: Spiral converge (0–0.30)
    // Phase 2: Hold as text   (0.30–0.72) — 756ms hold
    // Phase 3: Explode outward (0.72–1.0)
    for (let i = 0; i < count; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2
      const spd = this.speeds[i]

      if (t < 0.30) {
        const ct = t / 0.30
        const ease = easeOutCubic(ct)
        const spiralAngle = (1 - ease) * spd * 3
        const orbX = Math.cos(spiralAngle + i) * (1 - ease) * (3 + spd)
        const orbY = Math.sin(spiralAngle + i * 0.7) * (1 - ease) * (2 + spd * 0.5)
        posAttr.array[ix] = orbX * (1 - ease) + this.targets[ix] * ease
        posAttr.array[iy] = orbY * (1 - ease) + this.targets[iy] * ease
        posAttr.array[iz] = (Math.sin(i + elapsed * 0.002) * 0.5) * (1 - ease) + this.targets[iz] * ease
      } else if (t < 0.72) {
        const breath = Math.sin(elapsed * 0.006) * 0.015
        posAttr.array[ix] = this.targets[ix] * (1 + breath)
        posAttr.array[iy] = this.targets[iy] * (1 + breath)
        posAttr.array[iz] = this.targets[iz]
      } else {
        const et = (t - 0.72) / 0.28
        const ease = et * et
        const dir = i % 2 === 0 ? 1 : -1
        posAttr.array[ix] = this.targets[ix] + Math.cos(i * 0.1) * spd * 3 * ease * dir
        posAttr.array[iy] = this.targets[iy] + Math.sin(i * 0.13) * spd * 2 * ease
        posAttr.array[iz] = this.targets[iz] + spd * 2 * ease * dir
      }
    }
    posAttr.needsUpdate = true

    // Fade out during explosion phase
    this.mat.uniforms.uOpacity.value = t < 0.72 ? 0.85 : Math.max(0, 0.85 - ((t - 0.72) / 0.28) * 0.85)

    // Gentle camera drift
    this.camera.position.x = Math.sin(elapsed * 0.0005) * 0.25
    this.camera.position.y = Math.cos(elapsed * 0.0004) * 0.12

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

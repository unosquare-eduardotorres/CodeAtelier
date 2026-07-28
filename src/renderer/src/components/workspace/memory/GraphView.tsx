/**
 * GraphView — “Nebula Brain” 3D WebGL knowledge graph visualization.
 *
 * Uses react-force-graph-3d with nodeThreeObjectExtend: native spheres
 * augmented with glow halo sprites, orbital rings for hub nodes,
 * UnrealBloomPass post-processing, and a procedural starfield background.
 *
 * Colors read from CSS custom properties so all 4 themes work.
 * Respects prefers-reduced-motion.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import type { ForceGraphMethods, NodeObject, LinkObject } from 'react-force-graph-3d'
import type { ForceLink, ForceManyBody, SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'
import {
  Color,
  Vector2,
  SpriteMaterial,
  Sprite,
  AdditiveBlending,
  CanvasTexture,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  Points,
  Group,
  RingGeometry,
  MeshBasicMaterial,
  Mesh,
  DoubleSide,
  // ── Planet textures + star twinkle ──
  SphereGeometry,
  ShaderMaterial,
  BackSide
} from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import {
  Waypoints,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  Pause,
  Play,
  Search,
  X,
  Orbit
} from 'lucide-react'
import { useMemoryStore } from '@renderer/store'
import { ErrorBoundary } from '@renderer/components/common/ErrorBoundary'
import NodeDetailPanel from './NodeDetailPanel'
import FilterPopover from './FilterPopover'
import { CATEGORY_COLOR_VAR, EDGE_COLOR_VAR, TIER_LABELS } from './graph-constants'
import type {
  MemoryFact,
  MemoryGraphData,
  MemoryGraphEdgeKind,
  MemoryFactCategory
} from '../../../../../shared/types'

// ── Types ──

interface GNode {
  id: string
  title: string
  category: MemoryFactCategory
  tier: number
  status: string
  confidence: number
}

interface GLink {
  source: string
  target: string
  kind: MemoryGraphEdgeKind
  weight: number
}

// ── CSS vars resolved during render (cached to avoid per-frame getComputedStyle) ──

const GRAPH_CSS_VARS = [
  '--graph-node-decision',
  '--graph-node-convention',
  '--graph-node-gotcha',
  '--graph-node-preference',
  '--graph-node-reference',
  '--graph-text',
  '--graph-link',
  '--graph-glow',
  '--graph-edge-superseded',
  '--graph-edge-contradiction',
  '--graph-bg'
] as const

// ── Edge styles (adapted for 3D — no dashes, using opacity/color differentiation) ──

const EDGE_STYLES: Record<MemoryGraphEdgeKind, { colorVar: string; alpha: number }> = {
  similarity: { colorVar: EDGE_COLOR_VAR.similarity, alpha: 0.25 },
  superseded: { colorVar: EDGE_COLOR_VAR.superseded, alpha: 0.45 },
  contradiction: { colorVar: EDGE_COLOR_VAR.contradiction, alpha: 0.6 }
}

// ── Physics freeze constant (d3-force default) ──

const DEFAULT_VELOCITY_DECAY = 0.4

// ── Default camera distance ──

const DEFAULT_CAMERA_Z = 600

// ── Utility: hex color + alpha → rgba string ──

function hexToRgba(hex: string, alpha: number): string {
  if (hex.startsWith('#') && hex.length >= 7) {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  if (hex.startsWith('#') && hex.length >= 4) {
    const r = parseInt(hex[1] + hex[1], 16)
    const g = parseInt(hex[2] + hex[2], 16)
    const b = parseInt(hex[3] + hex[3], 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  return hex
}

// ── Shared radial gradient texture for node glow halos (64×64, created once) ──

function createGlowTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.15, 'rgba(255,255,255,0.8)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.3)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const tex = new CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}
let _glowTexture: CanvasTexture | null = null
function getGlowTexture(): CanvasTexture {
  if (!_glowTexture) _glowTexture = createGlowTexture()
  return _glowTexture
}

// ── Shared procedural planet textures (one per category color, created once) ──

const _planetTextures = new Map<string, CanvasTexture>()

function createPlanetTexture(hexColor: string): CanvasTexture {
  const w = 128, h = 64
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Parse base color
  const r = parseInt(hexColor.slice(1, 3), 16)
  const g = parseInt(hexColor.slice(3, 5), 16)
  const b = parseInt(hexColor.slice(5, 7), 16)

  // Fill with base color
  ctx.fillStyle = hexColor
  ctx.fillRect(0, 0, w, h)

  // Horizontal bands — 5–7 bands with slight color variation
  const bandCount = 5 + Math.floor(Math.random() * 3)
  for (let i = 0; i < bandCount; i++) {
    const y = (h / bandCount) * i
    const bandH = h / bandCount
    const shift = (Math.random() - 0.5) * 40
    const br = Math.max(0, Math.min(255, r + shift))
    const bg = Math.max(0, Math.min(255, g + shift))
    const bb = Math.max(0, Math.min(255, b + shift))
    ctx.fillStyle = `rgba(${br},${bg},${bb},0.35)`
    ctx.fillRect(0, y, w, bandH * 0.6)
  }

  // Noise — small random dots for surface texture
  for (let i = 0; i < 200; i++) {
    const nx = Math.random() * w
    const ny = Math.random() * h
    const ns = 1 + Math.random() * 2
    const nAlpha = Math.random() * 0.15
    ctx.fillStyle = Math.random() > 0.5
      ? `rgba(255,255,255,${nAlpha})`
      : `rgba(0,0,0,${nAlpha})`
    ctx.fillRect(nx, ny, ns, ns * 0.5)
  }

  const tex = new CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

function getPlanetTexture(hexColor: string): CanvasTexture {
  let tex = _planetTextures.get(hexColor)
  if (!tex) {
    tex = createPlanetTexture(hexColor)
    _planetTextures.set(hexColor, tex)
  }
  return tex
}

// ── Shared per-tier geometries (4 tiers × 2 types = 8 total, created once) ──

const TIER_BASE_RADII = [
  Math.cbrt(1) * 5,
  Math.cbrt(2.5) * 5,
  Math.cbrt(5) * 5,
  Math.cbrt(9) * 5
] as const

const _texGeometries = TIER_BASE_RADII.map((r) => new SphereGeometry(r * 1.02, 24, 24))
const _atmoGeometries = TIER_BASE_RADII.map((r) => new SphereGeometry(r * 1.2, 24, 16))

// ── Star twinkle shader (GPU-animated per-vertex opacity oscillation) ──

const STAR_VERTEX_SHADER = `
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aBaseOpacity;
  attribute float aSize;
  uniform float uTime;
  varying float vOpacity;
  void main() {
    // Twinkle: sinusoidal oscillation per star
    float twinkle = sin(uTime * aSpeed + aPhase) * 0.35 + 0.65;
    vOpacity = aBaseOpacity * twinkle;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const STAR_FRAGMENT_SHADER = `
  varying float vOpacity;
  void main() {
    // Circular point with soft edge
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.15, dist) * vOpacity;
    gl_FragColor = vec4(0.88, 0.92, 1.0, alpha);
  }
`

// ── Props ──

interface GraphViewProps {
  workspaceId: string
}

// ── Component ──

export default function GraphView({ workspaceId }: GraphViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const fgRef = useRef<ForceGraphMethods<NodeObject<GNode>, LinkObject<GNode, GLink>>>(undefined)

  const { confirmFact, archiveFact, deleteFact } = useMemoryStore()

  const [graphData, setGraphData] = useState<MemoryGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [velocityDecay, setVelocityDecay] = useState(DEFAULT_VELOCITY_DECAY)
  const [graphKey, setGraphKey] = useState(0)
  const [hoveredNode, setHoveredNode] = useState<NodeObject<GNode> | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  // Detail panel (node click)
  const [selectedNode, setSelectedNode] = useState<NodeObject<GNode> | null>(null)
  const [selectedFact, setSelectedFact] = useState<MemoryFact | null>(null)
  const [factLoading, setFactLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const factRequestRef = useRef<string | null>(null)
  const workspaceIdRef = useRef(workspaceId)

  // Container dimensions
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 })

  // Controls state
  const [showFilters, setShowFilters] = useState(false)
  const [physicsPaused, setPhysicsPaused] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [autoOrbit, setAutoOrbit] = useState(false)
  const [filterCategories, setFilterCategories] = useState<Set<MemoryFactCategory>>(
    new Set(['decision', 'convention', 'gotcha', 'preference', 'reference'])
  )
  const [filterEdges, setFilterEdges] = useState<Set<MemoryGraphEdgeKind>>(
    new Set(['similarity', 'superseded', 'contradiction'])
  )
  const [filterTiers, setFilterTiers] = useState<Set<number>>(new Set([0, 1, 2, 3]))
  const [hideSuperseded, setHideSuperseded] = useState(true)
  const [themeGeneration, setThemeGeneration] = useState(0)

  // ── Unmount guards ──

  const mountedRef = useRef(true)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 3D-specific refs ──

  const orbitAngleRef = useRef(0)
  const nebulaFgRef = useRef<typeof fgRef.current>(undefined)
  const starfieldRef = useRef<Points | null>(null)
  const twinkleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibilityHandlerRef = useRef<(() => void) | null>(null)

  // ── Reduced motion ──

  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  )

  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mql) return
    const handleChange = (e: MediaQueryListEvent): void => {
      reducedMotion.current = e.matches
    }
    reducedMotion.current = mql.matches
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [])

  // ── Cached CSS colors (avoids ~30k getComputedStyle calls/sec) ──

  const colorCacheRef = useRef<Record<string, string>>({})

  /** Resolve all graph CSS vars into the cache (called on mount + theme change) */
  const readColors = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const style = getComputedStyle(el)
    const cache: Record<string, string> = {}
    for (const v of GRAPH_CSS_VARS) {
      cache[v] = style.getPropertyValue(v).trim() || '#666'
    }
    colorCacheRef.current = cache
  }, [])

  /** Fast cache lookup — O(1), no DOM access */
  const cachedColor = useCallback((varName: string): string => {
    return colorCacheRef.current[varName] || '#666'
  }, [])

  // ── Callback ref for container — fixes sizing bug ──

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      containerRef.current = node

      if (node) {
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect
            if (width > 0 && height > 0) {
              setDimensions({ width, height })
            }
          }
        })
        observer.observe(node)
        observerRef.current = observer

        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          setDimensions({ width: rect.width, height: rect.height })
        }

        readColors()
      }
    },
    [readColors]
  )

  // Cleanup on unmount — stop the force engine FIRST so no more
  // layoutTick() calls can crash on undefined state.layout
  useEffect(() => {
    return () => {
      mountedRef.current = false
      const fg = fgRef.current

      try {
        if (fg) {
          // Stop the animation frame loop FIRST — prevents any further
          // layoutTick() calls that would crash on nullified forces.
          fg.pauseAnimation()

          // NOW safe to remove forces
          fg.d3Force('link', null)
          fg.d3Force('charge', null)
          fg.d3Force('center', null)
        }
      } catch {
        // may already be disposed
      }

      // Cancel any pending zoomToFit timer
      if (zoomTimerRef.current !== null) {
        clearTimeout(zoomTimerRef.current)
        zoomTimerRef.current = null
      }

      // Dispose starfield + twinkle timer
      if (twinkleTimerRef.current !== null) {
        clearInterval(twinkleTimerRef.current)
        twinkleTimerRef.current = null
      }
      if (starfieldRef.current) {
        try {
          const scene = fg?.scene()
          if (scene) scene.remove(starfieldRef.current)
          starfieldRef.current.geometry.dispose()
          ;(starfieldRef.current.material as ShaderMaterial | PointsMaterial).dispose()
        } catch {
          /* already disposed */
        }
        starfieldRef.current = null
      }
      nebulaFgRef.current = undefined

      observerRef.current?.disconnect()
    }
  }, [])

  // Refresh color cache + scene background on theme change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      readColors()
      _planetTextures.clear()
      setThemeGeneration((v) => v + 1)
      // Update scene background to match theme
      if (fgRef.current) {
        try {
          const scene = fgRef.current.scene()
          const bgColor = colorCacheRef.current['--graph-bg'] || '#010208'
          scene.background = new Color(bgColor)
        } catch {
          // scene may not be ready yet
        }
      }
      // nodeColor callback will pick up new CSS vars on next React render
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [readColors])

  // ── Load graph data ──

  useEffect(() => {
    workspaceIdRef.current = workspaceId
    let cancelled = false
    factRequestRef.current = null

    async function fetchGraph(): Promise<void> {
      setLoading(true)
      setError(null)
      setSelectedNode(null)
      setSelectedFact(null)
      setHoveredNode(null)
      setTooltipPos(null)

      try {
        const data = await window.api.memoryGraphGet({ workspaceId })
        if (!cancelled) {
          setGraphData(data)
          setLoading(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError((err as Error)?.message ?? 'Failed to load graph')
          setLoading(false)
        }
      }
    }
    fetchGraph()

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // ── Filtered graph data (drives stats + rendering) ──

  const filteredData = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return { nodes: [], links: [] }

    const filteredNodes = graphData.nodes.filter((n) => {
      if (!filterCategories.has(n.category)) return false
      if (!filterTiers.has(Math.min(n.tier, 3))) return false
      if (hideSuperseded && (n.status === 'superseded' || n.status === 'archived')) return false
      return true
    })
    const nodeIds = new Set(filteredNodes.map((n) => n.id))
    const filteredLinks = graphData.edges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && filterEdges.has(e.kind))
      .map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        weight: e.weight
      }))

    return {
      nodes: filteredNodes.map((n) => ({ ...n })) as NodeObject<GNode>[],
      links: filteredLinks as LinkObject<GNode, GLink>[]
    }
  }, [graphData, filterCategories, filterEdges, filterTiers, hideSuperseded])

  // ── Connection degree map (for orbital rings on hub nodes) ──

  const connectionDegree = useMemo(() => {
    const deg = new Map<string, number>()
    for (const link of filteredData.links) {
      const s =
        typeof link.source === 'object' ? (link.source as NodeObject<GNode>).id : link.source
      const t =
        typeof link.target === 'object' ? (link.target as NodeObject<GNode>).id : link.target
      deg.set(s as string, (deg.get(s as string) ?? 0) + 1)
      deg.set(t as string, (deg.get(t as string) ?? 0) + 1)
    }
    return deg
  }, [filteredData.links])

  const forceGraphVisible = filteredData.nodes.length > 0

  // ── Nebula effects: bloom post-processing + procedural starfield ──

  useEffect(() => {
    const fg = fgRef.current
    if (!fg || fg === nebulaFgRef.current) return

    const rafId = requestAnimationFrame(() => {
      const currentFg = fgRef.current
      if (!currentFg || currentFg === nebulaFgRef.current) return

      // ── Bloom ──
      try {
        const composer = currentFg.postProcessingComposer()
        const renderer = currentFg.renderer()
        const size = renderer.getSize(new Vector2())
        const bloomPass = new UnrealBloomPass(
          new Vector2(size.x, size.y),
          0.5, // strength — subtle glow
          0.3, // radius — tight halos
          0.8 // threshold — higher = less bloom on mid-range colors
        )
        composer.addPass(bloomPass)
        composer.addPass(new OutputPass())
      } catch (err) {
        console.warn('[GraphView] Bloom setup failed (non-fatal):', err)
      }

      // ── Starfield with GPU twinkle ──
      try {
        const scene = currentFg.scene()

        // Remove previous starfield + stop twinkle timer
        if (starfieldRef.current) {
          scene.remove(starfieldRef.current)
          starfieldRef.current.geometry.dispose()
          ;(starfieldRef.current.material as ShaderMaterial | PointsMaterial).dispose()
        }
        if (twinkleTimerRef.current !== null) {
          clearInterval(twinkleTimerRef.current)
          twinkleTimerRef.current = null
        }

        const count = 5000
        const spread = 3000
        const positions = new Float32Array(count * 3)
        const phases = new Float32Array(count)
        const speeds = new Float32Array(count)
        const baseOpacities = new Float32Array(count)
        const sizes = new Float32Array(count)

        for (let i = 0; i < count; i++) {
          positions[i * 3]     = (Math.random() - 0.5) * spread
          positions[i * 3 + 1] = (Math.random() - 0.5) * spread
          positions[i * 3 + 2] = (Math.random() - 0.5) * spread
          phases[i]        = Math.random() * Math.PI * 2      // random phase offset
          speeds[i]        = 0.3 + Math.random() * 1.2        // twinkle speed
          baseOpacities[i] = 0.25 + Math.random() * 0.75      // brightness variety
          sizes[i]         = 0.6 + Math.random() * 2.4        // size variety
        }

        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
        geo.setAttribute('aPhase', new Float32BufferAttribute(phases, 1))
        geo.setAttribute('aSpeed', new Float32BufferAttribute(speeds, 1))
        geo.setAttribute('aBaseOpacity', new Float32BufferAttribute(baseOpacities, 1))
        geo.setAttribute('aSize', new Float32BufferAttribute(sizes, 1))

        const mat = new ShaderMaterial({
          uniforms: { uTime: { value: 0 } },
          vertexShader: STAR_VERTEX_SHADER,
          fragmentShader: STAR_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false
        })

        const stars = new Points(geo, mat)
        stars.raycast = () => {}  // non-interactive
        scene.add(stars)
        starfieldRef.current = stars

        // Animate twinkle — skip if user prefers reduced motion
        if (!reducedMotion.current) {
          twinkleTimerRef.current = setInterval(() => {
            if (starfieldRef.current) {
              const shaderMat = starfieldRef.current.material as ShaderMaterial
              if (shaderMat.uniforms?.uTime) {
                shaderMat.uniforms.uTime.value = performance.now() / 1000
              }
            }
          }, 33)  // ~30fps — sufficient for subtle twinkle
        }
      } catch (err) {
        console.warn('[GraphView] Starfield setup failed (non-fatal):', err)
      }

      // ── Pause twinkle when tab hidden ──
      const handleVisibility = (): void => {
        if (document.hidden) {
          if (twinkleTimerRef.current !== null) {
            clearInterval(twinkleTimerRef.current)
            twinkleTimerRef.current = null
          }
        } else if (!reducedMotion.current && starfieldRef.current) {
          twinkleTimerRef.current = setInterval(() => {
            if (starfieldRef.current) {
              const shaderMat = starfieldRef.current.material as ShaderMaterial
              if (shaderMat.uniforms?.uTime) {
                shaderMat.uniforms.uTime.value = performance.now() / 1000
              }
            }
          }, 33)
        }
      }
      visibilityHandlerRef.current = handleVisibility
      document.addEventListener('visibilitychange', handleVisibility)

      nebulaFgRef.current = currentFg
    })
    return () => {
      cancelAnimationFrame(rafId)
      if (visibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', visibilityHandlerRef.current)
        visibilityHandlerRef.current = null
      }
    }
  }, [graphKey, forceGraphVisible])

  // ── Category counts for filter popover ──

  const categoryCounts = useMemo(() => {
    if (!graphData) return {} as Record<MemoryFactCategory, number>
    const counts: Record<string, number> = {}
    for (const n of graphData.nodes) {
      if (hideSuperseded && (n.status === 'superseded' || n.status === 'archived')) continue
      counts[n.category] = (counts[n.category] ?? 0) + 1
    }
    return counts as Record<MemoryFactCategory, number>
  }, [graphData, hideSuperseded])

  // ── Tier counts for filter popover ──

  const tierCounts = useMemo(() => {
    if (!graphData) return {} as Record<number, number>
    const counts: Record<number, number> = {}
    for (const n of graphData.nodes) {
      if (hideSuperseded && (n.status === 'superseded' || n.status === 'archived')) continue
      const t = Math.min(n.tier, 3)
      counts[t] = (counts[t] ?? 0) + 1
    }
    return counts
  }, [graphData, hideSuperseded])

  // ── Search match set ──

  const searchMatchIds = useMemo(() => {
    const ids = new Set<string>()
    if (!searchText.trim()) return ids
    const q = searchText.toLowerCase()
    for (const node of filteredData.nodes) {
      if (
        (node.title ?? '').toLowerCase().includes(q) ||
        (node.category ?? '').toLowerCase().includes(q)
      ) {
        ids.add(node.id as string)
      }
    }
    return ids
  }, [searchText, filteredData.nodes])

  // ── Derive effective selection — auto-nulls when selected node is filtered out ──

  const effectiveSelectedNode = useMemo(
    () =>
      selectedNode && filteredData.nodes.some((n) => n.id === selectedNode.id)
        ? selectedNode
        : null,
    [selectedNode, filteredData.nodes]
  )

  // Build neighbor set for hover highlight
  const neighborIds = useMemo(() => {
    const ids = new Set<string>()
    if (!hoveredNode) return ids
    ids.add(hoveredNode.id as string)
    for (const link of filteredData.links) {
      const s =
        typeof link.source === 'object' ? (link.source as NodeObject<GNode>).id : link.source
      const t =
        typeof link.target === 'object' ? (link.target as NodeObject<GNode>).id : link.target
      if (s === hoveredNode.id) ids.add(t as string)
      if (t === hoveredNode.id) ids.add(s as string)
    }
    return ids
  }, [hoveredNode, filteredData.links])

  // ── Node rendering accessors ──

  /** Node size by tier (maps to sphere volume via nodeVal) */
  const nodeVal = useCallback((node: NodeObject<GNode>) => {
    const tier = Math.min(node.tier ?? 0, 3)
    return [1, 2.5, 5, 9][tier] // T0=small, T3=large
  }, [])

  /** Node color with highlight/dim state (replaces updateMaterialStates) */
  const nodeColor = useCallback(
    (node: NodeObject<GNode>) => {
      const colorVar = CATEGORY_COLOR_VAR[node.category] ?? '--graph-node-reference'
      const baseColor = cachedColor(colorVar)
      const isDimmed = node.status === 'superseded' || node.status === 'archived'
      const nodeId = node.id as string

      let alpha: number
      if (searchMatchIds.size > 0) {
        alpha = searchMatchIds.has(nodeId) ? 1.0 : 0.1
      } else if (hoveredNode) {
        const isHoverTarget = nodeId === (hoveredNode.id as string)
        alpha = isHoverTarget ? 1.0 : neighborIds.has(nodeId) ? (isDimmed ? 0.45 : 0.85) : 0.06
      } else {
        alpha = isDimmed ? 0.3 : 0.75
      }

      return hexToRgba(baseColor, alpha)
    },
    [cachedColor, hoveredNode, neighborIds, searchMatchIds]
  )

  // ── Node three-object: planet texture + atmosphere + glow halo + orbital rings (extends native sphere) ──

  const nodeThreeObject = useCallback(
    (node: NodeObject<GNode>) => {
      const group = new Group()
      const tier = Math.min(node.tier ?? 0, 3)
      const colorVar = CATEGORY_COLOR_VAR[node.category] ?? '--graph-node-reference'
      const hexColor = cachedColor(colorVar)
      const threeColor = new Color(hexColor)
      const nodeId = node.id as string
      const degree = connectionDegree.get(nodeId) ?? 0
      const baseRadius = TIER_BASE_RADII[tier]

      // ── Planet surface texture overlay ──
      // Sits just outside the native sphere; depthWrite:false avoids z-fighting.
      // The native sphere (MeshLambertMaterial) handles color + hover alpha;
      // this overlay adds procedural band texture on top.
      const texGeo = _texGeometries[tier]
      const texMat = new MeshBasicMaterial({
        map: getPlanetTexture(hexColor),
        transparent: true,
        opacity: [0.3, 0.35, 0.4, 0.5][tier],   // higher tiers = more visible texture
        depthWrite: false
      })
      const texSphere = new Mesh(texGeo, texMat)
      texSphere.raycast = () => {}  // non-interactive
      // Random axis tilt per node for visual variety
      texSphere.rotation.x = Math.random() * Math.PI
      texSphere.rotation.z = Math.random() * 0.5
      group.add(texSphere)

      // ── Atmosphere rim shell ──
      // BackSide renders only the inner face → visible as a bright rim/limb.
      const atmoGeo = _atmoGeometries[tier]
      const atmoMat = new MeshBasicMaterial({
        color: threeColor,
        transparent: true,
        opacity: [0.04, 0.07, 0.10, 0.15][tier],  // subtle for T0, vivid for T3
        side: BackSide,
        depthWrite: false
      })
      const atmoShell = new Mesh(atmoGeo, atmoMat)
      atmoShell.raycast = () => {}  // non-interactive
      group.add(atmoShell)

      // ── Glow halo sprite (additive blending = neon bloom) ──
      const glowMat = new SpriteMaterial({
        map: getGlowTexture(),
        color: threeColor,
        transparent: true,
        blending: AdditiveBlending,
        opacity: reducedMotion.current
          ? [0.06, 0.08, 0.12, 0.18][tier]
          : [0.08, 0.12, 0.2, 0.3][tier],
        depthWrite: false
      })
      const glow = new Sprite(glowMat)
      const glowScale = baseRadius * [2.2, 2.8, 3.5, 4.5][tier]
      glow.scale.set(glowScale, glowScale, 1)
      glow.raycast = () => {}  // prevent glow from intercepting clicks
      group.add(glow)

      // ── Orbital ring for hub nodes (5+ connections) ──
      if (degree >= 5) {
        const ringGeo = new RingGeometry(baseRadius * 1.8, baseRadius * 2.1, 32)
        const ringMat = new MeshBasicMaterial({
          color: threeColor,
          transparent: true,
          opacity: 0.25,
          side: DoubleSide,
          depthWrite: false
        })
        const ring = new Mesh(ringGeo, ringMat)
        ring.raycast = () => {}  // non-interactive
        ring.rotation.x = Math.PI * 0.4
        ring.rotation.y = reducedMotion.current ? 0 : Math.random() * Math.PI
        group.add(ring)
      }

      // ── Second ring for super-hubs (10+ connections) ──
      if (degree >= 10) {
        const ring2Geo = new RingGeometry(baseRadius * 2.5, baseRadius * 2.7, 32)
        const ring2Mat = new MeshBasicMaterial({
          color: threeColor,
          transparent: true,
          opacity: 0.12,
          side: DoubleSide,
          depthWrite: false
        })
        const ring2 = new Mesh(ring2Geo, ring2Mat)
        ring2.raycast = () => {}
        ring2.rotation.x = Math.PI * 0.65
        ring2.rotation.z = reducedMotion.current ? 0 : Math.random() * Math.PI
        group.add(ring2)
      }

      return group
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- themeGeneration forces object recreation on theme change
    [cachedColor, connectionDegree, themeGeneration]
  )

  // ── Configure forces + fit to view after data loads ──

  useEffect(() => {
    if (filteredData.nodes.length > 0 && fgRef.current) {
      const fg = fgRef.current

      // Configure link force distances
      const linkForce = fg.d3Force('link') as
        | ForceLink<
            NodeObject<GNode> & SimulationNodeDatum,
            GLink & SimulationLinkDatum<NodeObject<GNode> & SimulationNodeDatum>
          >
        | undefined
      if (linkForce) {
        linkForce
          .distance((d) => {
            if (d.kind === 'superseded') return 40
            if (d.kind === 'contradiction') return 60
            return 80 + (1 - d.weight) * 50
          })
          .strength(0.3)
      }

      // Configure charge force — MUCH stronger for 1000+ nodes, no distanceMax cap
      const chargeForce = fg.d3Force('charge') as
        | ForceManyBody<NodeObject<GNode> & SimulationNodeDatum>
        | undefined
      if (chargeForce) {
        chargeForce.strength(-300)
      }

      // Remove collide force — stronger charge handles separation
      fg.d3Force('collide', null)

      // Ensure physics + render loop are fully running before reheat
      fg.resumeAnimation()
      setVelocityDecay(DEFAULT_VELOCITY_DECAY)
      if (physicsPaused) {
        queueMicrotask(() => setPhysicsPaused(false))
      }

      // Wrap d3ReheatSimulation in requestAnimationFrame to ensure the
      // kapsule update with new graphData has fully processed (sets state.layout)
      // BEFORE we call resetCountdown() (which sets engineRunning = true)
      requestAnimationFrame(() => {
        if (mountedRef.current && fgRef.current) {
          fgRef.current.d3ReheatSimulation()
        }
      })

      // Allow simulation to settle, then fit
      zoomTimerRef.current = setTimeout(() => {
        if (mountedRef.current && fgRef.current) {
          fgRef.current.zoomToFit(400, 40)
        }
      }, 500)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- physicsPaused intentionally omitted to avoid re-trigger loops
  }, [filteredData])

  // ── Re-fit on resize ──

  useEffect(() => {
    if (fgRef.current && filteredData.nodes.length > 0) {
      fgRef.current.zoomToFit(300, 40)
    }
  }, [dimensions, filteredData.nodes.length])

  // ── Link styling callbacks ──

  const linkColor = useCallback(
    (link: LinkObject<GNode, GLink>) => {
      const style = EDGE_STYLES[link.kind as MemoryGraphEdgeKind] ?? EDGE_STYLES.similarity
      const color = cachedColor(style.colorVar)
      let alpha = style.alpha

      if (searchMatchIds.size > 0) {
        const s =
          typeof link.source === 'object' ? (link.source as NodeObject<GNode>).id : link.source
        const t =
          typeof link.target === 'object' ? (link.target as NodeObject<GNode>).id : link.target
        const bothMatch = searchMatchIds.has(s as string) && searchMatchIds.has(t as string)
        alpha = bothMatch ? Math.min(style.alpha * 1.5, 1) : style.alpha * 0.08
      } else if (hoveredNode) {
        const s =
          typeof link.source === 'object' ? (link.source as NodeObject<GNode>).id : link.source
        const t =
          typeof link.target === 'object' ? (link.target as NodeObject<GNode>).id : link.target
        const isNeighborEdge = neighborIds.has(s as string) && neighborIds.has(t as string)
        alpha = isNeighborEdge ? Math.min(style.alpha * 1.5, 1) : style.alpha * 0.1
      }

      return hexToRgba(color, alpha)
    },
    [cachedColor, hoveredNode, neighborIds, searchMatchIds]
  )

  const linkWidth = useCallback((link: LinkObject<GNode, GLink>) => {
    if (link.kind === 'similarity') return 0.5 + (link.weight ?? 0) * 1.5
    if (link.kind === 'contradiction') return 2
    if (link.kind === 'superseded') return 1.2
    return 1.5
  }, [])

  const linkParticleColor = useCallback(
    (l: LinkObject<GNode, GLink>) =>
      cachedColor(
        l.kind === 'contradiction'
          ? EDGE_COLOR_VAR.contradiction
          : l.kind === 'superseded'
            ? EDGE_COLOR_VAR.superseded
            : '--graph-node-decision'
      ),
    [cachedColor]
  )

  // ── Reduced link particles (performance) ──

  const linkParticleCount = useCallback((l: LinkObject<GNode, GLink>) => {
    if (reducedMotion.current) return 0
    if (l.kind === 'similarity') return 0
    return 2
  }, [])

  const linkParticleSpeed = useCallback((l: LinkObject<GNode, GLink>) => {
    return l.kind === 'contradiction' ? 0.008 : 0.004
  }, [])

  // ── Hover handler ──

  const handleNodeHover = useCallback((node: NodeObject<GNode> | null) => {
    setHoveredNode(node)
    if (node && containerRef.current) {
      const fg = fgRef.current
      if (fg && node.x != null && node.y != null) {
        const screenCoords = fg.graph2ScreenCoords(node.x, node.y, node.z ?? 0)
        setTooltipPos({ x: screenCoords.x, y: screenCoords.y })
      }
    } else {
      setTooltipPos(null)
    }
  }, [])

  // ── Node click → select for detail panel + fly-to-focus ──

  const handleNodeClick = useCallback(
    (node: NodeObject<GNode>) => {
      if (selectedNode?.id === node.id) {
        factRequestRef.current = null
        setSelectedNode(null)
        setSelectedFact(null)
        return
      }
      const nodeId = node.id as string
      factRequestRef.current = nodeId
      setSelectedNode(node)
      setSelectedFact(null)
      setFactLoading(true)

      // 3D: fly camera to node
      if (fgRef.current && node.x != null && node.y != null) {
        const distance = 120
        fgRef.current.cameraPosition(
          { x: node.x, y: node.y, z: (node.z ?? 0) + distance },
          { x: node.x, y: node.y, z: node.z ?? 0 },
          800
        )
      }

      window.api
        .memoryFactsGet({ id: nodeId })
        .then((fact) => {
          if (factRequestRef.current === nodeId) setSelectedFact(fact)
        })
        .catch(() => {
          if (factRequestRef.current === nodeId) setSelectedFact(null)
        })
        .finally(() => {
          if (factRequestRef.current === nodeId) setFactLoading(false)
        })
    },
    [selectedNode]
  )

  // ── Detail panel actions ──

  const handleDetailConfirm = useCallback(async () => {
    if (!selectedNode || actionBusy) return
    const actedId = selectedNode.id as string
    setActionBusy(true)
    try {
      await confirmFact(actedId, workspaceId)
      const data = await window.api.memoryGraphGet({ workspaceId })
      if (workspaceIdRef.current !== workspaceId) return
      setGraphData(data)
      if (factRequestRef.current === actedId) factRequestRef.current = null
      setSelectedNode((cur) => (cur && cur.id === actedId ? null : cur))
      setSelectedFact((cur) => (cur && cur.id === actedId ? null : cur))
    } finally {
      setActionBusy(false)
    }
  }, [selectedNode, workspaceId, confirmFact, actionBusy])

  const handleDetailArchive = useCallback(async () => {
    if (!selectedNode || actionBusy) return
    const actedId = selectedNode.id as string
    setActionBusy(true)
    try {
      await archiveFact(actedId, workspaceId)
      const data = await window.api.memoryGraphGet({ workspaceId })
      if (workspaceIdRef.current !== workspaceId) return
      setGraphData(data)
      if (factRequestRef.current === actedId) factRequestRef.current = null
      setSelectedNode((cur) => (cur && cur.id === actedId ? null : cur))
      setSelectedFact((cur) => (cur && cur.id === actedId ? null : cur))
    } finally {
      setActionBusy(false)
    }
  }, [selectedNode, workspaceId, archiveFact, actionBusy])

  const handleDetailDelete = useCallback(async () => {
    if (!selectedNode || actionBusy) return
    const actedId = selectedNode.id as string
    setActionBusy(true)
    try {
      await deleteFact(actedId)
      const data = await window.api.memoryGraphGet({ workspaceId })
      if (workspaceIdRef.current !== workspaceId) return
      setGraphData(data)
      if (factRequestRef.current === actedId) factRequestRef.current = null
      setSelectedNode((cur) => (cur && cur.id === actedId ? null : cur))
      setSelectedFact((cur) => (cur && cur.id === actedId ? null : cur))
    } finally {
      setActionBusy(false)
    }
  }, [selectedNode, workspaceId, deleteFact, actionBusy])

  // ── Search: Enter flies to first match ──

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && searchMatchIds.size > 0) {
        const firstId = searchMatchIds.values().next().value
        const node = filteredData.nodes.find((n) => n.id === firstId)
        if (node && fgRef.current && node.x != null && node.y != null) {
          const distance = 150
          fgRef.current.cameraPosition(
            { x: node.x, y: node.y, z: (node.z ?? 0) + distance },
            { x: node.x, y: node.y, z: node.z ?? 0 },
            500
          )
        }
      }
    },
    [searchMatchIds, filteredData.nodes]
  )

  // ── 3D Camera control cluster handlers ──

  const handleZoomIn = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    const pos = (fg as any).cameraPosition() as { x: number; y: number; z: number }
    const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || DEFAULT_CAMERA_Z
    const factor = 0.75
    const newDist = dist * factor
    fg.cameraPosition(
      { x: (pos.x * newDist) / dist, y: (pos.y * newDist) / dist, z: (pos.z * newDist) / dist },
      undefined,
      300
    )
  }, [])

  const handleZoomOut = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    const pos = (fg as any).cameraPosition() as { x: number; y: number; z: number }
    const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z) || DEFAULT_CAMERA_Z
    const factor = 1.3
    const newDist = dist * factor
    fg.cameraPosition(
      { x: (pos.x * newDist) / dist, y: (pos.y * newDist) / dist, z: (pos.z * newDist) / dist },
      undefined,
      300
    )
  }, [])

  const handleFitToView = useCallback(() => {
    fgRef.current?.zoomToFit(400, 40)
  }, [])

  const handleReset = useCallback(() => {
    fgRef.current?.cameraPosition({ x: 0, y: 0, z: DEFAULT_CAMERA_Z }, { x: 0, y: 0, z: 0 }, 500)
  }, [])

  const handleTogglePhysics = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    if (physicsPaused) {
      setVelocityDecay(DEFAULT_VELOCITY_DECAY)
      fg.d3ReheatSimulation()
    } else {
      setVelocityDecay(1)
    }
    setPhysicsPaused((v) => !v)
  }, [physicsPaused])

  // ── Background click handler ──

  const handleBackgroundClick = useCallback(() => {
    factRequestRef.current = null
    setHoveredNode(null)
    setTooltipPos(null)
    setSelectedNode(null)
    setSelectedFact(null)
    setAutoOrbit(false)
  }, [])

  // ── Engine stop handler (simplified — no bloom/lighting setup needed) ──

  const handleEngineStop = useCallback(() => {
    // Scene is stable — nothing else to initialize with native rendering
  }, [])

  // ── 3D: Auto-orbit (cinematic idle rotation) ──

  useEffect(() => {
    if (!autoOrbit || !fgRef.current) return

    // Sync orbit angle from current camera position
    const pos = (fgRef.current as any).cameraPosition() as { x: number; y: number; z: number }
    orbitAngleRef.current = Math.atan2(pos.x, pos.z)

    const interval = setInterval(() => {
      if (!fgRef.current) return
      const curPos = (fgRef.current as any).cameraPosition() as { x: number; y: number; z: number }
      const curDist =
        Math.sqrt(curPos.x * curPos.x + curPos.y * curPos.y + curPos.z * curPos.z) ||
        DEFAULT_CAMERA_Z
      orbitAngleRef.current += Math.PI / 600
      fgRef.current.cameraPosition({
        x: curDist * Math.sin(orbitAngleRef.current),
        y: curPos.y,
        z: curDist * Math.cos(orbitAngleRef.current)
      })
    }, 30)

    // Stop orbit when user interacts with controls
    const controls = fgRef.current.controls() as any
    const stopOrbit = (): void => {
      setAutoOrbit(false)
    }
    controls?.addEventListener?.('start', stopOrbit)

    return () => {
      clearInterval(interval)
      controls?.removeEventListener?.('start', stopOrbit)
    }
  }, [autoOrbit])

  // ── Legend toggle handler ──

  const handleLegendCategoryToggle = useCallback((cat: MemoryFactCategory) => {
    setFilterCategories((prev) => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }, [])

  // ── Render states ──

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-text-muted gap-3">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">Building knowledge graph…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-text-muted gap-2">
        <p className="text-sm text-danger">{error}</p>
      </div>
    )
  }

  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-text-muted gap-2">
        <Waypoints className="w-8 h-8 opacity-50" />
        <p className="text-sm">No memories to visualize.</p>
        <p className="text-xs">
          Memories are automatically extracted from sessions, commits, and documents.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={setContainerRef}
      data-testid="memory-graph-canvas"
      className="relative w-full h-[calc(100vh-280px)] min-h-[500px] rounded-lg border border-border-default overflow-hidden"
      style={{ backgroundColor: 'var(--graph-bg)' }}
    >
      {filteredData.nodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-text-muted gap-2">
          <Waypoints className="w-8 h-8 opacity-50" />
          <p className="text-sm">No memories match current filters.</p>
          <button
            onClick={() => {
              setFilterCategories(
                new Set(['decision', 'convention', 'gotcha', 'preference', 'reference'])
              )
              setFilterTiers(new Set([0, 1, 2, 3]))
              setFilterEdges(new Set(['similarity', 'superseded', 'contradiction']))
              setHideSuperseded(true)
            }}
            className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-surface-raised rounded border border-border-default transition-colors"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <ErrorBoundary
          key={graphKey}
          fallback={
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3">
              <p className="text-sm text-danger">Graph rendering failed</p>
              <button
                onClick={() => setGraphKey((k) => k + 1)}
                className="px-3 py-1.5 text-xs bg-surface-overlay hover:bg-surface-raised rounded border border-border-default transition-colors"
              >
                Reload Graph
              </button>
            </div>
          }
        >
          <ForceGraph3D
            ref={fgRef}
            graphData={filteredData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="#010208"
            showNavInfo={false}
            // ── Node rendering — sphere + glow halo + rings ──
            nodeVal={nodeVal}
            nodeRelSize={5}
            nodeResolution={24}
            nodeColor={nodeColor}
            nodeOpacity={1}
            nodeLabel=""
            nodeThreeObject={nodeThreeObject}
            nodeThreeObjectExtend={true}
            // ── Link styling ──
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkOpacity={1}
            linkCurvature={0.2}
            linkResolution={6}
            // ── Directional particles ──
            linkDirectionalParticles={linkParticleCount}
            linkDirectionalParticleSpeed={linkParticleSpeed}
            linkDirectionalParticleWidth={3}
            linkDirectionalParticleColor={linkParticleColor}
            linkDirectionalParticleResolution={4}
            // ── Force engine ──
            warmupTicks={80}
            cooldownTime={8000}
            d3AlphaDecay={0.025}
            d3VelocityDecay={velocityDecay}
            // ── Interaction ──
            onNodeHover={handleNodeHover}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
            onEngineStop={handleEngineStop}
            enableNodeDrag={true}
            enableNavigationControls={true}
          />
        </ErrorBoundary>
      )}

      {/* ── Find-in-graph search (top-center) ── */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-surface-raised/90 backdrop-blur-sm rounded-md border border-border-default px-2 py-1">
        <Search className="w-3.5 h-3.5 text-text-muted" />
        <input
          type="text"
          placeholder="Find in graph…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          className="bg-transparent text-xs text-text-primary placeholder:text-text-muted w-32 focus:w-48 transition-all focus:outline-none"
        />
        {searchText && (
          <>
            <span className="text-[10px] text-text-muted">{searchMatchIds.size} found</span>
            <button
              onClick={() => setSearchText('')}
              className="p-0.5 text-text-muted hover:text-text-primary"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      {/* ── Control Cluster (top-left) ── */}
      <div className="absolute top-3 left-3 flex flex-col gap-1 bg-surface-raised/80 backdrop-blur-sm rounded-md border border-border-default p-1">
        <button
          onClick={handleZoomIn}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded"
          title="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={handleZoomOut}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded"
          title="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={handleFitToView}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded"
          title="Fit to view"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <button
          onClick={handleReset}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded"
          title="Reset camera"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
        <div className="border-t border-border-default my-0.5" />
        <button
          onClick={() => {
            setAutoOrbit((v) => !v)
          }}
          className={`p-1.5 rounded ${autoOrbit ? 'text-info bg-info/10' : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'}`}
          title={autoOrbit ? 'Stop auto-orbit' : 'Auto-orbit'}
        >
          <Orbit className="w-4 h-4" />
        </button>
        <button
          onClick={handleTogglePhysics}
          className={`p-1.5 rounded ${physicsPaused ? 'text-warning bg-warning/10' : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'}`}
          title={physicsPaused ? 'Resume physics' : 'Pause physics'}
        >
          {physicsPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
        </button>
      </div>

      {/* ── Filter Button + Popover (top-right) — hidden when detail panel is open ── */}
      {!effectiveSelectedNode && (
        <FilterPopover
          nodeCount={filteredData.nodes.length}
          linkCount={filteredData.links.length}
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters((v) => !v)}
          filterCategories={filterCategories}
          onToggleCategory={(cat) => {
            setFilterCategories((prev) => {
              const next = new Set(prev)
              next.has(cat) ? next.delete(cat) : next.add(cat)
              return next
            })
          }}
          categoryCounts={categoryCounts}
          filterTiers={filterTiers}
          onToggleTier={(t) => {
            setFilterTiers((prev) => {
              const next = new Set(prev)
              next.has(t) ? next.delete(t) : next.add(t)
              return next
            })
          }}
          tierCounts={tierCounts}
          filterEdges={filterEdges}
          onToggleEdge={(kind) => {
            setFilterEdges((prev) => {
              const next = new Set(prev)
              next.has(kind) ? next.delete(kind) : next.add(kind)
              return next
            })
          }}
          hideSuperseded={hideSuperseded}
          onToggleHideSuperseded={() => setHideSuperseded((v) => !v)}
        />
      )}

      {/* ── Clickable Legend (bottom) ── */}
      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[10px] text-text-muted bg-surface-raised/80 backdrop-blur-sm rounded px-2 py-1">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            {(['decision', 'convention', 'gotcha', 'preference', 'reference'] as const).map(
              (cat) => (
                <button
                  key={cat}
                  onClick={() => handleLegendCategoryToggle(cat)}
                  className={`flex items-center gap-1 px-1 py-0.5 rounded transition-opacity ${
                    filterCategories.has(cat) ? 'opacity-100' : 'opacity-30'
                  } hover:opacity-100`}
                  title={`Toggle ${cat}`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: `var(${CATEGORY_COLOR_VAR[cat]})` }}
                  />
                  {cat}
                </button>
              )
            )}
          </div>
          <span className="text-border-default">|</span>
          <div className="flex items-center gap-2">
            <span>— similarity</span>
            <span style={{ color: 'var(--graph-edge-superseded)' }}>— superseded</span>
            <span style={{ color: 'var(--graph-edge-contradiction)' }}>— contradiction</span>
          </div>
        </div>
        <span className="text-text-muted/60 hidden sm:inline">
          🖱 Drag: orbit · Right-drag: pan · Scroll: zoom
        </span>
      </div>

      {/* ── Node Detail Panel (right side overlay) ── */}
      {effectiveSelectedNode && (
        <NodeDetailPanel
          title={effectiveSelectedNode.title}
          category={effectiveSelectedNode.category}
          tier={effectiveSelectedNode.tier ?? 0}
          confidence={effectiveSelectedNode.confidence ?? 0}
          status={effectiveSelectedNode.status}
          fact={selectedFact}
          factLoading={factLoading}
          onClose={() => {
            factRequestRef.current = null
            setSelectedNode(null)
            setSelectedFact(null)
          }}
          onConfirm={handleDetailConfirm}
          onArchive={handleDetailArchive}
          onDelete={handleDetailDelete}
          actionsDisabled={actionBusy}
        />
      )}

      {/* ── Hover tooltip ── */}
      {hoveredNode && !effectiveSelectedNode && tooltipPos && (
        <div
          className="absolute z-50 pointer-events-none px-3 py-2 text-xs bg-surface-float border border-border-default rounded-md shadow-lg max-w-[220px]"
          style={{
            left: Math.min(tooltipPos.x + 12, dimensions.width - 230),
            top: tooltipPos.y - 10
          }}
        >
          <p className="font-medium text-text-primary truncate">{hoveredNode.title}</p>
          <div className="flex items-center gap-2 mt-1 text-text-muted">
            <span>{hoveredNode.category}</span>
            <span>·</span>
            <span>{TIER_LABELS[hoveredNode.tier ?? 0]}</span>
            <span>·</span>
            <span>{Math.round((hoveredNode.confidence ?? 0) * 100)}%</span>
          </div>
          {hoveredNode.status !== 'active' && (
            <p className="mt-1 text-warning text-[10px]">{hoveredNode.status}</p>
          )}
        </div>
      )}
    </div>
  )
}

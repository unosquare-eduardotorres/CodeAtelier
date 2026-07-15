/**
 * GraphView — Obsidian-style knowledge graph visualization for memory facts.
 *
 * Uses react-force-graph-2d (d3-force under the hood) for canvas rendering,
 * built-in zoom/pan/drag/hover/click, DPR-aware sharpness, and auto-layout.
 *
 * Colors read from CSS custom properties so all 4 themes work.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { ForceGraphMethods, NodeObject, LinkObject } from 'react-force-graph-2d'
import type { ForceLink, ForceManyBody, SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'
import { forceCollide } from 'd3-force'
import {
  Waypoints,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  Type,
  Pause,
  Play,
  Search,
  X
} from 'lucide-react'
import { useMemoryStore } from '@renderer/store'
import NodeDetailPanel from './NodeDetailPanel'
import FilterPopover from './FilterPopover'
import { CATEGORY_COLOR_VAR, TIER_LABELS } from './graph-constants'
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

// ── Edge styles ──

const EDGE_STYLES: Record<
  MemoryGraphEdgeKind,
  { dash: number[] | null; colorVar: string; alpha: number }
> = {
  similarity: { dash: null, colorVar: '--color-border-default', alpha: 0.35 },
  superseded: { dash: [6, 4], colorVar: '--color-warning', alpha: 0.6 },
  contradiction: { dash: [4, 3], colorVar: '--color-danger', alpha: 0.7 }
}

// ── Tier → radius mapping ──

function tierRadius(tier: number): number {
  return 6 + tier * 3 // T0=6, T1=9, T2=12, T3=15
}

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
  const [labelsOn, setLabelsOn] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [physicsPaused, setPhysicsPaused] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [filterCategories, setFilterCategories] = useState<Set<MemoryFactCategory>>(
    new Set(['decision', 'convention', 'gotcha', 'preference', 'reference'])
  )
  const [filterEdges, setFilterEdges] = useState<Set<MemoryGraphEdgeKind>>(
    new Set(['similarity', 'superseded', 'contradiction'])
  )
  const [filterTiers, setFilterTiers] = useState<Set<number>>(new Set([0, 1, 2, 3]))
  const [hideSuperseded, setHideSuperseded] = useState(true)

  // ── Read CSS colors ──

  const getColor = useCallback((varName: string): string => {
    if (!containerRef.current) return '#666'
    return getComputedStyle(containerRef.current).getPropertyValue(varName).trim() || '#666'
  }, [])

  // ── Callback ref for container — fixes sizing bug ──
  // The ResizeObserver must attach whenever the container DOM node mounts
  // (survives loading→ready transition and tab switches).

  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    // Clean up old observer
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

      // Initial size
      const rect = node.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: rect.width, height: rect.height })
      }
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

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
            if (d.kind === 'superseded') return 50
            if (d.kind === 'contradiction') return 80
            return 100 + (1 - d.weight) * 60
          })
          .strength(0.4)
      }

      // Configure charge force
      const chargeForce = fg.d3Force('charge') as
        | ForceManyBody<NodeObject<GNode> & SimulationNodeDatum>
        | undefined
      if (chargeForce) {
        chargeForce.strength(-120).distanceMax(300)
      }

      // Add collide force
      fg.d3Force(
        'collide',
        forceCollide<NodeObject<GNode> & SimulationNodeDatum>().radius(
          (d) => tierRadius((d as NodeObject<GNode>).tier ?? 0) + 4
        )
      )

      // Always ensure animation is running before reheat
      fg.resumeAnimation()
      if (physicsPaused) {
        queueMicrotask(() => setPhysicsPaused(false))
      }

      fg.d3ReheatSimulation()

      // Allow simulation to settle, then fit
      setTimeout(() => fg.zoomToFit(400, 40), 500)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- physicsPaused intentionally omitted to avoid re-trigger loops
  }, [filteredData])

  // ── Re-fit on resize ──

  useEffect(() => {
    if (fgRef.current && filteredData.nodes.length > 0) {
      fgRef.current.zoomToFit(300, 40)
    }
  }, [dimensions, filteredData.nodes.length])

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

  // ── Node canvas rendering ──

  const nodeCanvasObject = useCallback(
    (node: NodeObject<GNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0
      const y = node.y ?? 0
      const r = tierRadius(node.tier ?? 0)
      const colorVar = CATEGORY_COLOR_VAR[node.category] ?? '--color-text-muted'
      const color = getColor(colorVar)

      // Dimming logic
      const isDimmed = node.status === 'superseded' || node.status === 'archived'
      const isHovered = hoveredNode && node.id === hoveredNode.id
      const isSelected = effectiveSelectedNode && node.id === effectiveSelectedNode.id
      const isSearchMatch = searchMatchIds.size > 0 && searchMatchIds.has(node.id as string)
      const isNeighbor = !hoveredNode || neighborIds.has(node.id as string)

      // Alpha calculation: search mode dims non-matches, hover mode dims non-neighbors
      let nodeAlpha: number
      if (searchMatchIds.size > 0) {
        nodeAlpha = isSearchMatch ? 1.0 : 0.12
      } else if (hoveredNode) {
        nodeAlpha = isNeighbor ? (isDimmed ? 0.5 : 1.0) : 0.08
      } else {
        nodeAlpha = isDimmed ? 0.35 : 1.0
      }

      ctx.globalAlpha = nodeAlpha

      // Glow for hovered / selected / search-matched node
      if (isHovered || isSelected || isSearchMatch) {
        ctx.beginPath()
        ctx.arc(x, y, r + 4, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.globalAlpha = isSelected ? 0.35 : 0.2
        ctx.fill()
        ctx.globalAlpha = nodeAlpha
      }

      // Node circle
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // Subtle border (highlight selected)
      if (isSelected) {
        ctx.strokeStyle = getColor('--color-primary')
        ctx.globalAlpha = 0.8
        ctx.lineWidth = 1.5
      } else {
        ctx.strokeStyle = getColor('--color-border-default')
        ctx.globalAlpha = nodeAlpha * 0.5
        ctx.lineWidth = 0.5
      }
      ctx.stroke()

      // Label: when labels toggled on, show for visible zoom and tier ≥ 2;
      // always show label for the hovered/selected node
      const showLabel = labelsOn
        ? globalScale > 0.8 && (node.tier ?? 0) >= 2 && nodeAlpha > 0.3
        : (isHovered || isSelected) && nodeAlpha > 0.3
      if (showLabel) {
        ctx.globalAlpha = nodeAlpha * 0.85
        ctx.font = `${Math.max(9, 11 / globalScale)}px system-ui, sans-serif`
        ctx.fillStyle = getColor('--color-text-primary')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const label =
          (node.title ?? '').length > 28
            ? (node.title ?? '').slice(0, 26) + '…'
            : (node.title ?? '')
        ctx.fillText(label, x, y + r + 3)
      }

      ctx.globalAlpha = 1
    },
    [getColor, hoveredNode, effectiveSelectedNode, labelsOn, searchMatchIds, neighborIds]
  )

  // ── Node pointer area (for hit detection) ──

  const nodePointerAreaPaint = useCallback(
    (node: NodeObject<GNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const r = tierRadius(node.tier ?? 0) + 3
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2)
      ctx.fill()
    },
    []
  )

  // ── Link styling callbacks ──

  const linkColor = useCallback(
    (link: LinkObject<GNode, GLink>) => {
      const style = EDGE_STYLES[link.kind as MemoryGraphEdgeKind] ?? EDGE_STYLES.similarity
      const color = getColor(style.colorVar)
      // Apply alpha — search dimming takes precedence over hover dimming
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
      // Simple hex→rgba conversion
      if (color.startsWith('#') && color.length >= 7) {
        const r = parseInt(color.slice(1, 3), 16)
        const g = parseInt(color.slice(3, 5), 16)
        const b = parseInt(color.slice(5, 7), 16)
        return `rgba(${r},${g},${b},${alpha})`
      }
      return color
    },
    [getColor, hoveredNode, neighborIds, searchMatchIds]
  )

  const linkLineDash = useCallback((link: LinkObject<GNode, GLink>) => {
    return EDGE_STYLES[link.kind as MemoryGraphEdgeKind]?.dash ?? null
  }, [])

  const linkWidth = useCallback((link: LinkObject<GNode, GLink>) => {
    return link.kind === 'similarity' ? 0.5 + (link.weight ?? 0) * 1.5 : 1.5
  }, [])

  // ── Hover handler ──

  const handleNodeHover = useCallback((node: NodeObject<GNode> | null) => {
    setHoveredNode(node)
    if (node && containerRef.current) {
      const fg = fgRef.current
      if (fg && node.x != null && node.y != null) {
        const screenCoords = fg.graph2ScreenCoords(node.x, node.y)
        setTooltipPos({ x: screenCoords.x, y: screenCoords.y })
      }
    } else {
      setTooltipPos(null)
    }
  }, [])

  // ── Node click → select for detail panel ──

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

  // ── Search: Enter centers on first match ──

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && searchMatchIds.size > 0) {
        const firstId = searchMatchIds.values().next().value
        const node = filteredData.nodes.find((n) => n.id === firstId)
        if (node && fgRef.current && node.x != null && node.y != null) {
          fgRef.current.centerAt(node.x, node.y, 500)
          fgRef.current.zoom(2, 500)
        }
      }
    },
    [searchMatchIds, filteredData.nodes]
  )

  // ── Control cluster handlers ──

  const handleZoomIn = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    const currentZoom = fg.zoom()
    fg.zoom(currentZoom * 1.25, 300)
  }, [])

  const handleZoomOut = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    const currentZoom = fg.zoom()
    fg.zoom(currentZoom * 0.8, 300)
  }, [])

  const handleFitToView = useCallback(() => {
    fgRef.current?.zoomToFit(400, 40)
  }, [])

  const handleReset = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.centerAt(0, 0, 300)
    fg.zoom(1, 300)
  }, [])

  const handleTogglePhysics = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    if (physicsPaused) {
      fg.resumeAnimation()
    } else {
      fg.pauseAnimation()
    }
    setPhysicsPaused((v) => !v)
  }, [physicsPaused])

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
      className="relative w-full h-[calc(100vh-280px)] min-h-[500px] rounded-lg border border-border-default bg-surface-raised overflow-hidden"
    >
      <ForceGraph2D
        ref={fgRef}
        graphData={filteredData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="transparent"
        // Node styling
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        nodePointerAreaPaint={nodePointerAreaPaint}
        // Link styling
        linkColor={linkColor}
        linkLineDash={linkLineDash}
        linkWidth={linkWidth}
        // Force engine
        d3AlphaDecay={0.02}
        // Interaction
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        onBackgroundClick={() => {
          factRequestRef.current = null
          setHoveredNode(null)
          setTooltipPos(null)
          setSelectedNode(null)
          setSelectedFact(null)
        }}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        minZoom={0.2}
        maxZoom={4}
        autoPauseRedraw={true}
      />

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
          onClick={() => setLabelsOn((v) => !v)}
          className={`p-1.5 rounded ${labelsOn ? 'text-info bg-info/10' : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'}`}
          title={labelsOn ? 'Hide labels' : 'Show labels'}
        >
          <Type className="w-4 h-4" />
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
      <div className="absolute bottom-3 left-3 flex gap-4 text-[10px] text-text-muted bg-surface-raised/80 backdrop-blur-sm rounded px-2 py-1">
        <div className="flex items-center gap-2">
          {(['decision', 'convention', 'gotcha', 'preference', 'reference'] as const).map((cat) => (
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
          ))}
        </div>
        <span className="text-border-default">|</span>
        <div className="flex items-center gap-2">
          <span>— similarity</span>
          <span className="text-warning">┄ superseded</span>
          <span className="text-danger">┄ contradiction</span>
        </div>
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

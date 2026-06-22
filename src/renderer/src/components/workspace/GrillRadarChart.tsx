import type { GrillTrackScore } from '../../../../shared/types'
import { GRILL_TRACKS } from '../../../../shared/constants'

interface GrillRadarChartProps {
  trackScores: GrillTrackScore[]
  size?: number
  onTrackClick?: (trackId: string) => void
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#dc2626'
  if (score <= 40) return '#ea580c'
  if (score <= 60) return '#d97706'
  if (score <= 80) return '#65a30d'
  return '#16a34a'
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRad: number
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad)
  }
}

export default function GrillRadarChart({
  trackScores,
  size = 240,
  onTrackClick
}: GrillRadarChartProps): React.JSX.Element {
  const cx = size / 2
  const cy = size / 2
  const maxRadius = size / 2 - 32 // leave room for labels
  const levels = 4

  const n = trackScores.length
  if (n < 2) {
    // Not enough data points for a radar — show a simple message
    return (
      <div
        className="flex items-center justify-center text-xs text-text-muted"
        style={{ width: size, height: size }}
      >
        Complete 2+ tracks to see the radar chart
      </div>
    )
  }

  const angleStep = (2 * Math.PI) / n
  // Start from top (-π/2) so first axis points up
  const startAngle = -Math.PI / 2

  // Build axis lines and labels
  const axes = trackScores.map((ts, i) => {
    const angle = startAngle + i * angleStep
    const end = polarToCartesian(cx, cy, maxRadius, angle)
    const labelPos = polarToCartesian(cx, cy, maxRadius + 16, angle)
    const track = GRILL_TRACKS[ts.trackId]
    return { trackId: ts.trackId, angle, end, labelPos, name: track?.name ?? ts.trackId }
  })

  // Build concentric level polygons
  const levelPolygons = Array.from({ length: levels }, (_, lvl) => {
    const r = (maxRadius * (lvl + 1)) / levels
    const points = trackScores
      .map((_, i) => {
        const angle = startAngle + i * angleStep
        const p = polarToCartesian(cx, cy, r, angle)
        return `${p.x},${p.y}`
      })
      .join(' ')
    return points
  })

  // Build the data polygon
  const avgScore = trackScores.reduce((sum, ts) => sum + ts.score, 0) / trackScores.length
  const fillColor = getScoreColor(avgScore)

  const dataPoints = trackScores.map((ts, i) => {
    const angle = startAngle + i * angleStep
    const r = (ts.score / 100) * maxRadius
    return polarToCartesian(cx, cy, r, angle)
  })
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <div data-testid="grill-radar-chart" className="flex flex-col items-center gap-2">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="select-none">
        {/* Concentric level polygons */}
        {levelPolygons.map((points, i) => (
          <polygon
            key={`level-${i}`}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-border-subtle"
            opacity={0.5}
          />
        ))}

        {/* Axis lines */}
        {axes.map((axis) => (
          <line
            key={`axis-${axis.trackId}`}
            x1={cx}
            y1={cy}
            x2={axis.end.x}
            y2={axis.end.y}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-border-subtle"
            opacity={0.5}
          />
        ))}

        {/* Data polygon fill */}
        <polygon
          points={dataPolygon}
          fill={fillColor}
          fillOpacity={0.15}
          stroke={fillColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Data points */}
        {dataPoints.map((p, i) => (
          <circle
            key={`point-${trackScores[i].trackId}`}
            cx={p.x}
            cy={p.y}
            r={3}
            fill={getScoreColor(trackScores[i].score)}
            className="cursor-pointer"
            onClick={() => onTrackClick?.(trackScores[i].trackId)}
          />
        ))}

        {/* Axis labels */}
        {axes.map((axis) => {
          const score = trackScores.find((ts) => ts.trackId === axis.trackId)?.score ?? 0
          return (
            <text
              key={`label-${axis.trackId}`}
              x={axis.labelPos.x}
              y={axis.labelPos.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-text-secondary cursor-pointer hover:fill-text-primary transition-colors"
              fontSize={9}
              fontWeight={500}
              onClick={() => onTrackClick?.(axis.trackId)}
            >
              {axis.name} ({score})
            </text>
          )
        })}
      </svg>

      {/* Overall average score */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">Overall:</span>
        <span className="text-sm font-bold" style={{ color: fillColor }}>
          {Math.round(avgScore)}
        </span>
        <span className="text-xs text-text-muted">/ 100</span>
      </div>
    </div>
  )
}

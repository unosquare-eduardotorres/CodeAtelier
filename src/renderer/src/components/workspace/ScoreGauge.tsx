interface ScoreGaugeProps {
  score: number // 0-100
  size?: number // px, default 120
  label?: string // e.g. "Getting There"
}

function getScoreColor(score: number): string {
  if (score <= 20) return '#dc2626' // red-600 (cold/raw)
  if (score <= 40) return '#ea580c' // orange-600 (warming up)
  if (score <= 60) return '#d97706' // amber-600 (medium heat)
  if (score <= 80) return '#65a30d' // lime-600 (well done)
  return '#16a34a' // green-600 (perfectly grilled)
}

function getScoreLabel(score: number): string {
  if (score <= 20) return 'Raw'
  if (score <= 40) return 'Warming Up'
  if (score <= 60) return 'Medium Rare'
  if (score <= 80) return 'Well Done'
  return 'Perfectly Grilled 🔥'
}

export default function ScoreGauge({
  score,
  size = 120,
  label
}: ScoreGaugeProps): React.JSX.Element {
  const strokeWidth = 8
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clampedScore = Math.max(0, Math.min(100, score))
  const progress = (clampedScore / 100) * circumference
  const color = getScoreColor(clampedScore)
  const displayLabel = label || getScoreLabel(clampedScore)

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="transform -rotate-90"
        >
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-surface-overlay"
          />
          {/* Progress arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference - progress}
            className="transition-all duration-700 ease-out"
          />
        </svg>
        {/* Centered score number */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="font-bold leading-none transition-all duration-500"
            style={{ fontSize: size * 0.3, color }}
          >
            {clampedScore}
          </span>
          <span
            className="text-text-muted leading-none"
            style={{ fontSize: size * 0.12 }}
          >
            /100
          </span>
        </div>
      </div>
      <span
        className="text-xs font-semibold text-text-secondary text-center"
        style={{ color }}
      >
        {displayLabel}
      </span>
    </div>
  )
}

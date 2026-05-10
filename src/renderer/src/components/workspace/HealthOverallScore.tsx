import { Zap, Microscope } from 'lucide-react'
import ScoreGauge from './ScoreGauge'
import type { AuditMode, AuditResult } from '../../../../shared/types'

interface HealthOverallScoreProps {
  score: number | null
  completedCount: number
  totalCount: number
  mode: AuditMode
  results?: AuditResult[]
}

function getHealthLabel(score: number): string {
  if (score <= 20) return 'Critical'
  if (score <= 40) return 'Needs Work'
  if (score <= 60) return 'Fair'
  if (score <= 80) return 'Good'
  return 'Excellent'
}

function getCoverageNote(results?: AuditResult[]): string | null {
  if (!results || results.length === 0) return null

  const completedResults = results.filter((r) => r.status === 'completed')
  if (completedResults.length === 0) return null

  const insufficientCount = completedResults.filter((r) => r.coverageSufficient === false).length
  const totalFilesInspected = completedResults.reduce(
    (sum, r) => sum + (r.coverageStats?.fileCount ?? 0),
    0
  )

  if (insufficientCount > 0) {
    return `⚠ ${insufficientCount} auditor${insufficientCount !== 1 ? 's' : ''} had insufficient coverage`
  }

  if (totalFilesInspected > 0) {
    return `Based on ${totalFilesInspected} files across ${completedResults.length} auditors`
  }

  return null
}

export default function HealthOverallScore({
  score,
  completedCount,
  totalCount,
  mode,
  results
}: HealthOverallScoreProps): React.JSX.Element {
  const coverageNote = getCoverageNote(results)

  return (
    <div className="flex flex-col items-center gap-2">
      {score !== null ? (
        <ScoreGauge score={score} size={100} label={getHealthLabel(score)} />
      ) : (
        <div className="flex flex-col items-center gap-1">
          <div className="w-[100px] h-[100px] rounded-full border-4 border-surface-overlay flex items-center justify-center">
            <span className="text-2xl text-text-muted">—</span>
          </div>
          <span className="text-xs font-semibold text-text-muted">No score yet</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-1">
        {mode === 'light' ? (
          <Zap size={14} className="text-warning" />
        ) : (
          <Microscope size={14} className="text-info" />
        )}
        <span className="text-[10px] text-text-muted capitalize">{mode} audit</span>
      </div>
      <span className="text-[11px] text-text-muted">
        {completedCount}/{totalCount} auditors complete
      </span>
      {coverageNote && (
        <span className="text-[10px] text-text-muted italic mt-1">{coverageNote}</span>
      )}
    </div>
  )
}

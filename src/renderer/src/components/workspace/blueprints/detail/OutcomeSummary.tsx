/**
 * OutcomeSummary — stat strip for completed blueprint runs.
 *
 * Renders a compact row of metric chips:
 *   [28/28 tasks] [12 waves] [41 files created] [12 modified]
 *   [3 remediations] [Verify: Passed ✓] [Total: 1h 24m]
 *
 * Only shown for completed runs (status === 'complete').
 */

import type { JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Layers,
  FilePlus,
  FileEdit,
  ListChecks,
  Wrench
} from 'lucide-react'
import type { BlueprintOutcomeStats } from './phase-summaries'

interface OutcomeSummaryProps {
  stats: BlueprintOutcomeStats
}

function StatChip({
  icon: Icon,
  label,
  colorClass = 'text-text-secondary'
}: {
  icon: typeof CheckCircle2
  label: string
  colorClass?: string
}): JSX.Element {
  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-inset border border-border-subtle text-xs font-medium ${colorClass}`}>
      <Icon size={13} className="flex-shrink-0" />
      {label}
    </div>
  )
}

export function OutcomeSummary({ stats }: OutcomeSummaryProps): JSX.Element {
  const verifyIcon =
    stats.verifyStatus === 'passed' ? CheckCircle2 :
    stats.verifyStatus === 'human_needed' ? AlertTriangle :
    stats.verifyStatus === 'gaps_found' ? XCircle :
    CheckCircle2

  const verifyColor =
    stats.verifyStatus === 'passed' ? 'text-success' :
    stats.verifyStatus === 'human_needed' ? 'text-accent' :
    stats.verifyStatus === 'gaps_found' ? 'text-danger' :
    'text-text-secondary'

  const verifyLabel =
    stats.verifyStatus === 'passed' ? 'Passed ✓' :
    stats.verifyStatus === 'human_needed' ? 'Human Review' :
    stats.verifyStatus === 'gaps_found' ? 'Gaps Found' :
    stats.verifyStatus ?? 'N/A'

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle p-3">
      <div className="flex flex-wrap gap-2">
        <StatChip
          icon={ListChecks}
          label={`${stats.completedTasks}/${stats.totalTasks} tasks`}
          colorClass={stats.completedTasks === stats.totalTasks ? 'text-success' : 'text-text-secondary'}
        />

        {stats.totalWaves > 0 && (
          <StatChip icon={Layers} label={`${stats.totalWaves} waves`} />
        )}

        {stats.filesCreated > 0 && (
          <StatChip icon={FilePlus} label={`${stats.filesCreated} files created`} colorClass="text-success" />
        )}

        {stats.filesModified > 0 && (
          <StatChip icon={FileEdit} label={`${stats.filesModified} modified`} colorClass="text-info" />
        )}

        {stats.remediationCount > 0 && (
          <StatChip icon={Wrench} label={`${stats.remediationCount} remediations`} colorClass="text-warning" />
        )}

        {stats.verifyStatus && (
          <StatChip icon={verifyIcon} label={`Verify: ${verifyLabel}`} colorClass={verifyColor} />
        )}

        {stats.totalDuration && (
          <StatChip icon={Clock} label={`Total: ${stats.totalDuration}`} />
        )}
      </div>
    </div>
  )
}

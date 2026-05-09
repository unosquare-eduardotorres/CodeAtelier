import { CheckCircle2, XCircle, AlertTriangle, Clock, Lightbulb, FileCode } from 'lucide-react'
import type { BuildSummary } from '../../../../shared/types'
import { useSpecialistStore } from '@renderer/store'

interface BuildSummaryCardProps {
  summary: BuildSummary
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

export default function BuildSummaryCard({ summary }: BuildSummaryCardProps): React.JSX.Element {
  const specialists = useSpecialistStore((s) => s.specialists)
  const hasErrors = summary.tasks.some((t) => t.status === 'failed')
  const completedCount = summary.tasks.filter((t) => t.status === 'completed').length
  const failedCount = summary.tasks.filter((t) => t.status === 'failed').length

  // Aggregate unique files changed
  const allFiles = [...new Set(summary.tasks.flatMap((t) => t.filesChanged ?? []))]

  return (
    <div className="my-3 rounded border border-border-subtle bg-surface-overlay overflow-hidden">
      {/* Header */}
      <div
        className={`flex items-center gap-3 px-4 py-3 border-b ${
          hasErrors
            ? 'border-amber-500/20 bg-amber-500/10'
            : 'border-emerald-500/20 bg-emerald-500/10'
        }`}
      >
        <div
          className={`w-8 h-8 rounded flex items-center justify-center ${
            hasErrors ? 'bg-amber-500/20' : 'bg-emerald-500/20'
          }`}
        >
          {hasErrors ? (
            <AlertTriangle size={16} className="text-amber-400" />
          ) : (
            <CheckCircle2 size={16} className="text-emerald-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">
            {hasErrors ? 'Build Finished with Errors' : 'Build Complete'}
          </p>
          <p className="text-xs text-text-secondary">
            {completedCount} completed
            {failedCount > 0 && `, ${failedCount} failed`} &middot;{' '}
            {formatDuration(summary.totalDuration)}
          </p>
        </div>
      </div>

      {/* Task results table */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted">
              <th className="text-left py-1 pr-2 font-medium">#</th>
              <th className="text-left py-1 pr-2 font-medium">Specialist</th>
              <th className="text-left py-1 pr-2 font-medium">Status</th>
              <th className="text-right py-1 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {summary.tasks.map((task, idx) => (
              <tr key={task.taskId} className="border-t border-border-subtle/50">
                <td className="py-1.5 pr-2 text-text-muted">{idx + 1}</td>
                <td className="py-1.5 pr-2">
                  {(() => {
                    const spec = specialists.find((s) => s.agentId === task.specialist)
                    const displayName = spec?.alias ?? spec?.displayName ?? task.specialist
                    return <span className="font-medium text-text-primary">{displayName}</span>
                  })()}
                  <p className="text-text-muted truncate max-w-[300px]">{task.description}</p>
                </td>
                <td className="py-1.5 pr-2">
                  <span className="inline-flex items-center gap-1">
                    {task.status === 'completed' && (
                      <CheckCircle2 size={12} className="text-emerald-400" />
                    )}
                    {task.status === 'failed' && <XCircle size={12} className="text-red-400" />}
                    {task.status === 'skipped' && <Clock size={12} className="text-text-muted" />}
                    <span
                      className={
                        task.status === 'completed'
                          ? 'text-emerald-400'
                          : task.status === 'failed'
                            ? 'text-red-400'
                            : 'text-text-muted'
                      }
                    >
                      {task.status}
                    </span>
                  </span>
                  {task.error && (
                    <p className="text-red-400/80 text-[10px] mt-0.5 max-w-[400px]" title={task.error}>
                      {task.error}
                    </p>
                  )}
                </td>
                <td className="py-1.5 text-right text-text-muted">
                  {task.duration != null ? formatDuration(task.duration) : '\u2014'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Files changed */}
      {allFiles.length > 0 && (
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-1.5 mb-2">
            <FileCode size={13} className="text-sky-400" />
            <span className="text-xs font-medium text-text-secondary">
              Files Changed ({allFiles.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allFiles.map((file) => (
              <span
                key={file}
                className="inline-flex items-center gap-1 text-sky-400 font-mono text-xs bg-sky-400/10 px-1.5 py-0.5 rounded"
              >
                <FileCode size={12} />
                {file}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Deferred items */}
      {summary.deferredItems && summary.deferredItems.length > 0 && (
        <div className="px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={13} className="text-text-muted" />
            <span className="text-xs font-medium text-text-secondary">Deferred Items</span>
          </div>
          <ul className="space-y-1">
            {summary.deferredItems.map((item, idx) => (
              <li key={idx} className="text-xs text-text-body flex items-start gap-1.5">
                <span className="text-text-muted mt-0.5">&bull;</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendations */}
      {summary.recommendations && summary.recommendations.length > 0 && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Lightbulb size={13} className="text-amber-400" />
            <span className="text-xs font-medium text-text-secondary">Recommendations</span>
          </div>
          <ul className="space-y-1">
            {summary.recommendations.map((rec, idx) => (
              <li key={idx} className="text-xs text-text-body flex items-start gap-1.5">
                <span className="text-amber-400 mt-0.5">&bull;</span>
                {rec}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

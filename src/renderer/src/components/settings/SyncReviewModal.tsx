import { useState } from 'react'
import {
  ArrowLeftRight,
  X,
  Check,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import type { SyncDiff, SyncResult } from '../../../../shared/types'

interface SyncReviewModalProps {
  syncDiff: SyncDiff
  isSyncing: boolean
  onApply: (options?: { skipRemoved?: boolean }) => Promise<SyncResult | null>
  onDismiss: () => void
}

export default function SyncReviewModal({
  syncDiff,
  isSyncing,
  onApply,
  onDismiss
}: SyncReviewModalProps): React.JSX.Element {
  const [skipRemoved, setSkipRemoved] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['new', 'updated', 'removed', 'newSkills'])
  )
  const [result, setResult] = useState<SyncResult | null>(null)

  const toggleSection = (section: string): void => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  const handleApply = async (): Promise<void> => {
    const syncResult = await onApply({ skipRemoved })
    if (syncResult) {
      setResult(syncResult)
    }
  }

  // Show result summary
  if (result) {
    return (
      <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-700 bg-gray-900">
          <div className="flex items-center gap-3">
            <Check size={16} className="text-green-400" />
            <span className="text-sm font-semibold text-gray-200">Sync Complete</span>
          </div>
          <button
            onClick={onDismiss}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4 max-w-md">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
              <Check size={24} className="text-green-400" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-gray-200">Sync Applied Successfully</h3>
              <div className="flex flex-wrap justify-center gap-4 mt-3">
                {result.imported > 0 && (
                  <span className="text-xs text-green-400">{result.imported} imported</span>
                )}
                {result.updated > 0 && (
                  <span className="text-xs text-amber-400">{result.updated} updated</span>
                )}
                {result.deactivated > 0 && (
                  <span className="text-xs text-red-400">{result.deactivated} deactivated</span>
                )}
                {result.skillsImported > 0 && (
                  <span className="text-xs text-indigo-400">
                    {result.skillsImported} skills imported
                  </span>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-left">
                  <p className="text-xs font-medium text-red-400 mb-1">Errors:</p>
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs text-red-300">
                      {err}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={onDismiss}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-700 bg-gray-900">
        <div className="flex items-center gap-3">
          <ArrowLeftRight size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-gray-200">Review YAML Sync</span>
        </div>
        <button
          onClick={onDismiss}
          className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-4">
          {/* New Specialists */}
          {syncDiff.newSpecialists.length > 0 && (
            <SyncSection
              title="New Agents"
              count={syncDiff.newSpecialists.length}
              icon={<Plus size={14} className="text-green-400" />}
              color="green"
              isExpanded={expandedSections.has('new')}
              onToggle={() => toggleSection('new')}
            >
              {syncDiff.newSpecialists.map((agent) => (
                <div
                  key={agent.parsed.name}
                  className="flex items-center gap-3 p-3 bg-green-500/5 border border-green-500/10 rounded-lg"
                >
                  <span className="text-lg">🔧</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200">{agent.parsed.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {agent.parsed.description || agent.filename}
                    </p>
                    {agent.parsed.skills.length > 0 && (
                      <div className="flex gap-1 mt-1">
                        {agent.parsed.skills.map((skill) => (
                          <span
                            key={skill}
                            className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-500/10 text-indigo-400"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-green-400 font-medium">NEW</span>
                </div>
              ))}
            </SyncSection>
          )}

          {/* New Skills */}
          {syncDiff.newSkills.length > 0 && (
            <SyncSection
              title="New Skills"
              count={syncDiff.newSkills.length}
              icon={<Plus size={14} className="text-green-400" />}
              color="green"
              isExpanded={expandedSections.has('newSkills')}
              onToggle={() => toggleSection('newSkills')}
            >
              {syncDiff.newSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center gap-3 p-3 bg-green-500/5 border border-green-500/10 rounded-lg"
                >
                  <span className="text-lg">✨</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200">{skill.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {skill.frontmatter?.description || 'No description'}
                    </p>
                  </div>
                  <span className="text-xs text-green-400 font-medium">NEW</span>
                </div>
              ))}
            </SyncSection>
          )}

          {/* Updated Specialists */}
          {syncDiff.updatedSpecialists.length > 0 && (
            <SyncSection
              title="Updated Agents"
              count={syncDiff.updatedSpecialists.length}
              icon={<Pencil size={14} className="text-amber-400" />}
              color="amber"
              isExpanded={expandedSections.has('updated')}
              onToggle={() => toggleSection('updated')}
            >
              {syncDiff.updatedSpecialists.map(({ agent, dbRecord, changes }) => (
                <div
                  key={agent.parsed.name}
                  className="flex items-center gap-3 p-3 bg-amber-500/5 border border-amber-500/10 rounded-lg"
                >
                  <span className="text-lg">{dbRecord.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200">{dbRecord.displayName}</p>
                    <div className="flex gap-1 mt-1">
                      {changes.map((change) => (
                        <span
                          key={change}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-400"
                        >
                          {change}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs text-amber-400 font-medium">CHANGED</span>
                </div>
              ))}
            </SyncSection>
          )}

          {/* Removed Specialists */}
          {syncDiff.removedSpecialists.length > 0 && (
            <SyncSection
              title="Removed from Workspace"
              count={syncDiff.removedSpecialists.length}
              icon={<Trash2 size={14} className="text-red-400" />}
              color="red"
              isExpanded={expandedSections.has('removed')}
              onToggle={() => toggleSection('removed')}
            >
              {syncDiff.removedSpecialists.map((specialist) => (
                <div
                  key={specialist.id}
                  className="flex items-center gap-3 p-3 bg-red-500/5 border border-red-500/10 rounded-lg"
                >
                  <span className="text-lg">{specialist.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200">{specialist.displayName}</p>
                    <p className="text-xs text-gray-500">YAML file removed from workspace</p>
                  </div>
                  <span className="text-xs text-red-400 font-medium">REMOVED</span>
                </div>
              ))}

              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipRemoved}
                  onChange={(e) => setSkipRemoved(e.target.checked)}
                  className="rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-400">
                  Keep these specialists active (don&apos;t deactivate)
                </span>
              </label>
            </SyncSection>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-gray-700 bg-gray-900">
        <p className="text-xs text-gray-500">
          {syncDiff.unchangedSpecialists.length} specialist
          {syncDiff.unchangedSpecialists.length !== 1 ? 's' : ''} already in sync
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onDismiss}
            disabled={isSyncing}
            className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-gray-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={isSyncing}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {isSyncing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Applying...
              </>
            ) : (
              <>
                <Check size={14} />
                Apply All Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Collapsible Section ──

interface SyncSectionProps {
  title: string
  count: number
  icon: React.ReactNode
  color: string
  isExpanded: boolean
  onToggle: () => void
  children: React.ReactNode
}

function SyncSection({
  title,
  count,
  icon,
  isExpanded,
  onToggle,
  children
}: SyncSectionProps): React.JSX.Element {
  return (
    <div className="border border-gray-700/50 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown size={14} className="text-gray-500" />
        ) : (
          <ChevronRight size={14} className="text-gray-500" />
        )}
        {icon}
        <span className="text-sm font-medium text-gray-200">{title}</span>
        <span className="text-xs text-gray-500">({count})</span>
      </button>
      {isExpanded && <div className="px-4 pb-3 space-y-2">{children}</div>}
    </div>
  )
}

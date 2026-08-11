import React from 'react'
import { Check, AlertTriangle } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import ToggleRow from './ToggleRow'

interface AutomationSectionProps {
  settings: Record<string, unknown>
  githubConfigured: boolean
  hasRemote: boolean
  onToggle: (key: string, value: boolean) => void
}

export default function AutomationSection({
  settings,
  githubConfigured,
  hasRemote,
  onToggle
}: AutomationSectionProps): React.JSX.Element {
  // Unset means on for gitAutoBranch — branch-per-chat is the default because
  // isolation only engages for conversations that own a branch.
  const autoBranchOn = settings.gitAutoBranch !== false
  const activeCount = [autoBranchOn, settings.gitAutoPR, settings.gitAutoCleanup].filter(
    Boolean
  ).length

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          Automation
        </h3>
        {activeCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-success bg-success-muted px-2 py-0.5 rounded-full font-medium">
            <Check size={10} />
            {activeCount}/3 active
          </span>
        )}
      </div>

      {/* Fix #7: Dividers between toggle rows */}
      <SettingsCard className="divide-y divide-border-subtle">
        <div className="py-3 first:pt-0 last:pb-0">
          <ToggleRow
            label="Auto-create branches"
            description="Create a git branch for each conversation automatically"
            checked={autoBranchOn}
            onChange={(v) => onToggle('gitAutoBranch', v)}
          />
        </div>
        <div className="py-3 first:pt-0 last:pb-0">
          <ToggleRow
            label="Auto-create pull requests"
            description="Create a GitHub PR when completing a conversation"
            checked={!!settings.gitAutoPR}
            onChange={(v) => onToggle('gitAutoPR', v)}
          />
          {/* Fix #10: Dependency warning — requires GitHub + remote */}
          {!!settings.gitAutoPR && !githubConfigured && (
            <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
              <AlertTriangle size={10} />
              Requires GitHub connection
            </p>
          )}
          {!!settings.gitAutoPR && githubConfigured && !hasRemote && (
            <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
              <AlertTriangle size={10} />
              Requires a remote URL
            </p>
          )}
        </div>
        <div className="py-3 first:pt-0 last:pb-0">
          <ToggleRow
            label="Auto-cleanup branches"
            description="Delete branches after PRs are merged or closed"
            checked={!!settings.gitAutoCleanup}
            onChange={(v) => onToggle('gitAutoCleanup', v)}
          />
          {/* Fix #10: Dependency warning — requires auto-PR */}
          {!!settings.gitAutoCleanup && !settings.gitAutoPR && (
            <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
              <AlertTriangle size={10} />
              Requires auto-create pull requests to be enabled
            </p>
          )}
        </div>
      </SettingsCard>
    </section>
  )
}

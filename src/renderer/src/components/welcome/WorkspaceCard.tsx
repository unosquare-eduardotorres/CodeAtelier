import { ChevronRight } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'

/**
 * View-model for a workspace card on the welcome screen.
 * Renderer-only — assembled by `useWorkspaceCardsData` from existing IPC sources.
 */
export interface WorkspaceCardData {
  /** Resolved from CLAUDE.md → README.md → creative placeholder */
  description: string
  chatCounts: { active: number; total: number }
  capabilities: {
    /** githubStatus.configured */
    githubRepo: boolean
    /** settings.repomapEnabled */
    codeGraph: boolean
    /** settings.semanticSearchEnabled */
    semanticSearch: boolean
    /** projectSpecialist?.buildStatus === 'ready' */
    specialist: boolean
  }
}

interface Props {
  workspace: Workspace
  /** Undefined while the parent hook is still loading data for this workspace */
  data: WorkspaceCardData | undefined
  onOpen: (id: string) => void
  onDelete?: (id: string) => void
}

interface CapabilityChipProps {
  emoji: string
  label: string
  active: boolean
}

function CapabilityChip({ emoji, label, active }: CapabilityChipProps): React.JSX.Element {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-success-muted text-success'
          : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-surface-base text-text-muted opacity-60'
      }
      title={`${label} ${active ? 'active' : 'inactive'}`}
    >
      <span aria-hidden>{emoji}</span>
      <span>{label}</span>
      <span aria-hidden className="ml-0.5">
        {active ? '✓' : '○'}
      </span>
    </span>
  )
}

function DescriptionSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-1.5" aria-hidden>
      <div className="h-2.5 rounded bg-surface-base/80 animate-pulse w-11/12" />
      <div className="h-2.5 rounded bg-surface-base/80 animate-pulse w-3/5" />
    </div>
  )
}

export default function WorkspaceCard({ workspace, data, onOpen }: Props): React.JSX.Element {
  const isLoading = data === undefined
  const active = data?.chatCounts.active ?? 0
  const total = data?.chatCounts.total ?? 0

  return (
    <button
      type="button"
      onClick={() => onOpen(workspace.id)}
      className="group flex flex-col gap-3 w-full text-left p-4 rounded-2xl bg-surface-overlay border border-border-subtle hover:border-primary/40 hover:bg-surface-float/80 shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {/* Header: avatar + name + chevron */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary-muted text-primary-text text-sm font-semibold flex-shrink-0">
          {workspace.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">{workspace.name}</div>
          <div className="text-xs text-text-muted truncate">{workspace.repoPath}</div>
        </div>
        <ChevronRight
          size={16}
          className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        />
      </div>

      {/* Description (2-line clamp, skeleton while loading) */}
      <div className="min-h-[2.25rem]">
        {isLoading ? (
          <DescriptionSkeleton />
        ) : (
          <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">
            {data!.description}
          </p>
        )}
      </div>

      {/* Capability chips */}
      <div className="flex flex-wrap gap-1.5">
        <CapabilityChip emoji="🐙" label="GitHub" active={!!data?.capabilities.githubRepo} />
        <CapabilityChip emoji="🕸️" label="CodeGraph" active={!!data?.capabilities.codeGraph} />
        <CapabilityChip emoji="🔍" label="Semantic" active={!!data?.capabilities.semanticSearch} />
        <CapabilityChip emoji="🎓" label="Specialist" active={!!data?.capabilities.specialist} />
      </div>

      {/* Footer pills: Active / Total */}
      <div className="flex items-center gap-2 pt-1 border-t border-border-subtle">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary-muted text-primary-text">
          Active {active}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-base text-text-secondary">
          Total {total}
        </span>
      </div>
    </button>
  )
}

import {
  Settings,
  Zap,
  Lightbulb,
  Database,
  Users,
  FileText,
  GitBranch,
  Cpu,
  ChevronLeft,
  ChevronRight,
  X,
  ScrollText,
  Bot,
  ShieldCheck,
  Brain,
  Puzzle,
  Target,
  Landmark
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'

export type SettingsTab =
  | 'specialist'
  | 'health'
  | 'goals'
  | 'council'
  | 'models'
  | 'repository'
  | 'code-intelligence'
  | 'integrations'
  | 'team'
  | 'ideas'
  | 'memory'
  | 'documents'
  | 'tokens'
  | 'events'

type SettingsMenuGroup = 'tools' | 'configuration'

// eslint-disable-next-line react-refresh/only-export-components -- intentional co-located constant export with component
export const SETTINGS_MENU: {
  id: SettingsTab
  label: string
  icon: LucideIcon
  iconColor?: string
  group: SettingsMenuGroup
}[] = [
  // ── Tools (interactive / operational) ──
  { id: 'health', label: 'Health', icon: ShieldCheck, iconColor: 'text-success', group: 'tools' },
  { id: 'goals', label: 'Goals', icon: Target, iconColor: 'text-cyan-400', group: 'tools' },
  { id: 'council', label: 'Council', icon: Landmark, iconColor: 'text-purple-400', group: 'tools' },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb, iconColor: 'text-warning', group: 'tools' },
  // ── Configuration (settings) ──
  {
    id: 'specialist',
    label: 'Specialist',
    icon: Bot,
    iconColor: 'text-primary-text',
    group: 'configuration'
  },
  { id: 'team', label: 'Team', icon: Users, iconColor: 'text-info', group: 'configuration' },
  {
    id: 'repository',
    label: 'Repository',
    icon: GitBranch,
    iconColor: 'text-accent',
    group: 'configuration'
  },
  {
    id: 'code-intelligence',
    label: 'Code Intelligence',
    icon: Brain,
    iconColor: 'text-cyan-400',
    group: 'configuration'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Puzzle,
    iconColor: 'text-accent',
    group: 'configuration'
  },
  { id: 'models', label: 'Models', icon: Cpu, iconColor: 'text-success', group: 'configuration' },
  {
    id: 'documents',
    label: 'Documents',
    icon: FileText,
    iconColor: 'text-info',
    group: 'configuration'
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: Database,
    iconColor: 'text-mode-plan-text',
    group: 'configuration'
  },
  { id: 'tokens', label: 'Tokens', icon: Zap, group: 'configuration' },
  {
    id: 'events',
    label: 'Events',
    icon: ScrollText,
    iconColor: 'text-danger',
    group: 'configuration'
  }
]

interface WorkspaceSettingsPanelProps {
  isCollapsed: boolean
  onToggleCollapse: () => void
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onClose: () => void
}

export default function WorkspaceSettingsPanel({
  isCollapsed,
  onToggleCollapse,
  activeTab,
  onTabChange,
  onClose
}: WorkspaceSettingsPanelProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()

  return (
    <div
      className={`flex flex-col h-full bg-surface-raised border-r border-border-subtle transition-all duration-200 ${
        isCollapsed ? 'w-12' : 'w-72'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border-subtle flex-shrink-0">
        {!isCollapsed && (
          <>
            <Settings size={14} className="text-primary-text flex-shrink-0" />
            <span className="text-xs font-semibold text-text-primary truncate flex-1">
              Workspace Settings
            </span>
            <button
              onClick={onClose}
              className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors flex-shrink-0"
              aria-label="Close workspace settings"
              title="Close workspace settings (Esc)"
            >
              <X size={14} />
            </button>
          </>
        )}
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors flex-shrink-0"
          aria-label={isCollapsed ? 'Expand settings panel' : 'Collapse settings panel'}
          title={isCollapsed ? 'Expand settings panel' : 'Collapse settings panel'}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Workspace name (only when expanded) */}
      {!isCollapsed && activeWorkspace && (
        <div className="px-3 py-2 border-b border-border-subtle">
          <span className="text-[11px] text-text-muted truncate block">{activeWorkspace.name}</span>
        </div>
      )}

      {/* Navigation tabs */}
      <nav className="flex-1 overflow-y-auto p-2">
        {/* Tools group */}
        {!isCollapsed && (
          <div className="px-3 pt-1 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Tools
            </span>
          </div>
        )}
        <div className="space-y-0.5">
          {SETTINGS_MENU.filter((item) => item.group === 'tools').map((item) => {
            const Icon = item.icon
            const isActive = activeTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center gap-2.5 w-full rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  isCollapsed ? 'px-2 py-2 justify-center' : 'px-3 py-2'
                } ${
                  isActive
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                }`}
                title={isCollapsed ? item.label : undefined}
              >
                <Icon size={16} className={isActive ? undefined : item.iconColor} />
                {!isCollapsed && <span>{item.label}</span>}
              </button>
            )
          })}
        </div>

        {/* Divider between groups */}
        <div className="my-2 mx-2 border-t border-border-subtle" />

        {/* Configuration group */}
        {!isCollapsed && (
          <div className="px-3 pt-1 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Configuration
            </span>
          </div>
        )}
        <div className="space-y-0.5">
          {SETTINGS_MENU.filter((item) => item.group === 'configuration').map((item) => {
            const Icon = item.icon
            const isActive = activeTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center gap-2.5 w-full rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  isCollapsed ? 'px-2 py-2 justify-center' : 'px-3 py-2'
                } ${
                  isActive
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
                }`}
                title={isCollapsed ? item.label : undefined}
              >
                <Icon size={16} className={isActive ? undefined : item.iconColor} />
                {!isCollapsed && <span>{item.label}</span>}
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

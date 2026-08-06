import { useMemo } from 'react'
import {
  Search,
  Rocket,
  Cpu,
  GitBranch,
  Users,
  Lightbulb,
  Brain,
  Waypoints,
  FileText,
  Coins,
  UserCog,
  Wrench
} from 'lucide-react'
import { useHelpStore, HELP_SECTIONS } from '@renderer/store/help.store'
import type { HelpSection, HelpSectionMeta } from '@renderer/store/help.store'

/**
 * HelpTOC — Table of Contents sidebar for the Help view.
 *
 * Features:
 * - Search filter that matches section titles and descriptions
 * - Active section highlight
 * - Keyboard-navigable with visible focus states
 * - Collapsible on narrow viewports (managed by parent HelpView)
 */

interface HelpTOCProps {
  /** Whether to render in collapsed/mobile mode */
  isCollapsed?: boolean
  /** Callback when a section is selected (used to close mobile menu) */
  onSectionSelect?: () => void
}

/** Map section icon names to Lucide components */
const iconMap: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Rocket,
  Cpu,
  GitBranch,
  Users,
  Lightbulb,
  Brain,
  Waypoints,
  FileText,
  Coins,
  UserCog,
  Wrench
}

function SectionIcon({
  iconName,
  className
}: {
  iconName: string
  className?: string
}): React.JSX.Element {
  const Icon = iconMap[iconName]
  if (!Icon) return <Rocket size={16} className={className} />
  return <Icon size={16} className={className} />
}

/** Divider between section groups in the TOC */
function TOCDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <li className="pt-4 pb-1.5 px-3" role="separator">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
    </li>
  )
}

function TOCItem({
  section,
  isActive,
  onSelect
}: {
  section: HelpSectionMeta
  isActive: boolean
  onSelect: (id: HelpSection) => void
}): React.JSX.Element {
  return (
    <li>
      <button
        onClick={() => onSelect(section.id)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px] ${
          isActive
            ? 'bg-primary-muted text-primary-text font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        }`}
        aria-current={isActive ? 'page' : undefined}
        title={section.description}
      >
        <SectionIcon
          iconName={section.icon}
          className={isActive ? 'text-primary-text' : 'text-text-muted'}
        />
        <span className="truncate">{section.title}</span>
      </button>
    </li>
  )
}

export default function HelpTOC({
  isCollapsed = false,
  onSectionSelect
}: HelpTOCProps): React.JSX.Element {
  const { activeSection, setActiveSection, searchQuery, setSearchQuery } = useHelpStore()

  // Filter sections by search query
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) return HELP_SECTIONS
    const q = searchQuery.toLowerCase()
    return HELP_SECTIONS.filter(
      (s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    )
  }, [searchQuery])

  // Split into groups: Getting Started, Settings tabs, Advanced
  const gettingStarted = filteredSections.filter((s) => s.id === 'getting-started')
  const settingsTabs = filteredSections.filter(
    (s) => !['getting-started', 'specialists', 'skills'].includes(s.id)
  )
  const advanced = filteredSections.filter((s) => s.id === 'specialists' || s.id === 'skills')

  const handleSelect = (id: HelpSection): void => {
    setActiveSection(id)
    onSectionSelect?.()
  }

  if (isCollapsed) return <></>

  return (
    <nav
      className="w-56 flex-shrink-0 border-r border-border-subtle bg-surface-base flex flex-col h-full"
      aria-label="Help table of contents"
    >
      {/* Search input */}
      <div className="p-3 border-b border-border-subtle">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            data-testid="help-toc-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search help..."
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
            aria-label="Search help topics"
          />
        </div>
      </div>

      {/* Section list */}
      <div className="flex-1 overflow-y-auto py-2 px-1.5">
        <ul role="list" className="space-y-0.5">
          {gettingStarted.length > 0 && (
            <>
              {gettingStarted.map((s) => (
                <TOCItem
                  key={s.id}
                  section={s}
                  isActive={activeSection === s.id}
                  onSelect={handleSelect}
                />
              ))}
            </>
          )}

          {settingsTabs.length > 0 && (
            <>
              <TOCDivider label="Workspace Settings" />
              {settingsTabs.map((s) => (
                <TOCItem
                  key={s.id}
                  section={s}
                  isActive={activeSection === s.id}
                  onSelect={handleSelect}
                />
              ))}
            </>
          )}

          {advanced.length > 0 && (
            <>
              <TOCDivider label="Advanced" />
              {advanced.map((s) => (
                <TOCItem
                  key={s.id}
                  section={s}
                  isActive={activeSection === s.id}
                  onSelect={handleSelect}
                />
              ))}
            </>
          )}

          {filteredSections.length === 0 && (
            <li
              data-testid="help-toc-empty"
              className="px-3 py-6 text-center text-sm text-text-muted"
            >
              No matching topics found
            </li>
          )}
        </ul>
      </div>
    </nav>
  )
}

import { useEffect, useState, useMemo } from 'react'
import { Loader2, Search, Sparkles, Store } from 'lucide-react'
import { useMarketplaceStore } from '@renderer/store'
import SpecialistCard from './SpecialistCard'
import SpecialistEditPage from './SpecialistEditPage'
import SkillsLibrary from './SkillsLibrary'
import type { DiscoveredSkill, MarketplaceSpecialist, Skill } from '../../../../shared/types'
import { useSettingsStore } from '@renderer/store/settings.store'

interface SpecialistMarketplaceProps {
  workspacePath: string
}

type FilterTab = 'all' | 'active' | 'available'

const FILTER_TABS: { value: FilterTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'available', label: 'Available' }
]

export default function SpecialistMarketplace({
  workspacePath
}: SpecialistMarketplaceProps): React.JSX.Element {
  const {
    specialists,
    skills,
    filter,
    searchQuery,
    isLoading,
    activatingIds,
    error,
    loadMarketplace,
    activateSpecialist,
    deactivateSpecialist,
    activateAll,
    setFilter,
    setSearchQuery
  } = useMarketplaceStore()

  const { selectSkill } = useSettingsStore()

  const [configuringSpecialist, setConfiguringSpecialist] = useState<MarketplaceSpecialist | null>(
    null
  )
  const [isActivatingAll, setIsActivatingAll] = useState(false)

  useEffect(() => {
    loadMarketplace(workspacePath)
  }, [workspacePath, loadMarketplace])

  // Filtered + searched specialists
  const filteredSpecialists = useMemo(() => {
    let result = [...specialists]

    // Apply filter
    if (filter === 'active') {
      result = result.filter((s) => s.isActive && s.isDeployed)
    } else if (filter === 'available') {
      result = result.filter((s) => !s.isActive || !s.isDeployed)
    }

    // Apply search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (s) =>
          s.displayName.toLowerCase().includes(q) ||
          s.agentId.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.alias && s.alias.toLowerCase().includes(q)) ||
          s.skills.some((sk) => sk.name.toLowerCase().includes(q))
      )
    }

    return result
  }, [specialists, filter, searchQuery])

  const activatableSpecialists = specialists.filter((s) => !s.isCore)
  const activeCount = activatableSpecialists.filter((s) => s.isActive && s.isDeployed).length
  const totalCount = activatableSpecialists.length

  const handleAutoActivate = async (): Promise<void> => {
    setIsActivatingAll(true)
    try {
      await activateAll(workspacePath)
    } finally {
      setIsActivatingAll(false)
    }
  }

  const handleSkillClick = (skill: Skill): void => {
    // Leverage existing settings store to show skill detail
    // We need to create a DiscoveredSkill-like object
    selectSkill({
      name: skill.name,
      dirPath: skill.filePath.replace(/\/SKILL\.md$/, ''),
      hasSkillMd: true,
      referenceFiles: [],
      frontmatter: {
        name: skill.name,
        description: skill.description
      },
      lastUpdated: skill.lastUpdatedDate,
      isActive: true,
      source: 'workspace'
    } as DiscoveredSkill)
  }

  if (isLoading && specialists.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-3 text-text-secondary">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading marketplace...</span>
        </div>
      </div>
    )
  }

  // ── Full-page specialist editor ──
  if (configuringSpecialist) {
    return (
      <SpecialistEditPage
        specialist={configuringSpecialist}
        onBack={() => {
          setConfiguringSpecialist(null)
          // Reload marketplace to pick up any changes
          loadMarketplace(workspacePath)
        }}
      />
    )
  }

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Store size={18} className="text-primary-text" />
          <div>
            <h2 className="text-base font-semibold text-text-primary">Specialist Marketplace</h2>
            <p className="text-xs text-text-secondary">
              {activeCount} of {totalCount} specialists active
            </p>
          </div>
        </div>
        <button
          onClick={handleAutoActivate}
          disabled={isActivatingAll || activeCount === totalCount}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
            bg-primary text-white hover:bg-primary-hover
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isActivatingAll ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          Auto-Activate
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/30 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Filter bar + Search */}
      <div className="flex items-center gap-3">
        <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filter === tab.value
                  ? 'bg-primary/20 text-primary-text'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search specialists..."
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-xs text-text-primary
              placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
          />
        </div>
      </div>

      {/* Specialist grid */}
      {filteredSpecialists.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted">
          <Store size={32} className="mb-2 opacity-40" />
          <p className="text-sm">
            {searchQuery
              ? 'No specialists match your search'
              : filter === 'active'
                ? 'No active specialists'
                : 'No specialists available'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredSpecialists.map((specialist) => (
            <SpecialistCard
              key={specialist.id}
              specialist={specialist}
              isActivating={activatingIds.has(specialist.id)}
              onActivate={() => activateSpecialist(workspacePath, specialist.id)}
              onDeactivate={() => deactivateSpecialist(workspacePath, specialist.id)}
              onConfigure={() => setConfiguringSpecialist(specialist)}
            />
          ))}
        </div>
      )}

      {/* Skills Library */}
      <SkillsLibrary skills={skills} specialists={specialists} onSkillClick={handleSkillClick} />
    </div>
  )
}

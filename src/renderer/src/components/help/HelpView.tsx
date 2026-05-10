import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { ChevronLeft, Menu } from 'lucide-react'
import { useHelpStore } from '@renderer/store/help.store'
import type { HelpSection } from '@renderer/store/help.store'
import HelpTOC from './HelpTOC'
import HelpArticleRenderer from './HelpArticleRenderer'

// Direct raw imports — Vite resolves these at build time
import gettingStartedMd from '@renderer/content/help/getting-started.md?raw'
import modelsMd from '@renderer/content/help/models.md?raw'
import repositoryMd from '@renderer/content/help/repository.md?raw'
import teamMd from '@renderer/content/help/team.md?raw'
import ideasMd from '@renderer/content/help/ideas.md?raw'
import memoryMd from '@renderer/content/help/memory.md?raw'
import documentsMd from '@renderer/content/help/documents.md?raw'
import tokensMd from '@renderer/content/help/tokens.md?raw'
import specialistsMd from '@renderer/content/help/specialists.md?raw'
import skillsMd from '@renderer/content/help/skills.md?raw'

/**
 * HelpView — Full-page help / user manual view.
 *
 * Replaces the main content area when view === 'help'.
 * Internal two-column layout: TOC (left) + Article content (right).
 * TOC collapses to a top dropdown below 768px viewport width.
 *
 * First-time users land on Getting Started; returning users see their last-visited section.
 */

interface HelpViewProps {
  onBack: () => void
}

/** Static content map — loaded synchronously at bundle time */
const SECTION_CONTENT: Record<HelpSection, string> = {
  'getting-started': gettingStartedMd,
  models: modelsMd,
  repository: repositoryMd,
  team: teamMd,
  ideas: ideasMd,
  memory: memoryMd,
  documents: documentsMd,
  tokens: tokensMd,
  specialists: specialistsMd,
  skills: skillsMd
}

export default function HelpView({ onBack }: HelpViewProps): React.JSX.Element {
  const { activeSection, initFromStorage } = useHelpStore()
  const [showMobileTOC, setShowMobileTOC] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Initialize from localStorage on mount
  useEffect(() => {
    initFromStorage()
  }, [initFromStorage])

  // Derive content from activeSection — no state needed
  const content = useMemo(() => SECTION_CONTENT[activeSection] ?? '', [activeSection])

  // Scroll to top when section changes
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [activeSection])

  // Close mobile TOC when section is selected
  const handleMobileSectionSelect = useCallback(() => {
    setShowMobileTOC(false)
  }, [])

  // Check viewport width for responsive TOC
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsNarrow(mql.matches)
    const handler = (e: MediaQueryListEvent): void => setIsNarrow(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return (
    <div className="flex flex-col h-full w-full bg-surface-base">
      {/* Help sub-header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-surface-base flex-shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label="Back to previous view"
          title="Back (Esc)"
        >
          <ChevronLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold text-text-primary">Help & User Manual</h1>

        {/* Mobile TOC toggle */}
        {isNarrow && (
          <button
            onClick={() => setShowMobileTOC((prev) => !prev)}
            className="ml-auto p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label="Toggle table of contents"
            aria-expanded={showMobileTOC}
          >
            <Menu size={18} />
          </button>
        )}
      </div>

      {/* Mobile TOC dropdown */}
      {isNarrow && showMobileTOC && (
        <div className="border-b border-border-subtle bg-surface-base max-h-[60vh] overflow-y-auto">
          <HelpTOC onSectionSelect={handleMobileSectionSelect} />
        </div>
      )}

      {/* Main content area: TOC + Article */}
      <div className="flex flex-1 min-h-0">
        {/* Desktop TOC sidebar */}
        {!isNarrow && <HelpTOC />}

        {/* Article content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto" role="main">
          <div className="px-8 py-6 max-w-4xl mx-auto">
            <HelpArticleRenderer content={content} />
          </div>
        </div>
      </div>
    </div>
  )
}

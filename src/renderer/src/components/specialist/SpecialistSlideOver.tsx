/**
 * SpecialistSlideOver — the ⚙️ Specialist panel that slides in from the right
 * when a user clicks the chat-header button. Hosts four tabs:
 *
 *   - Prompt  (read/edit the LLM-tailored prompt + rebuild)
 *   - Skills  (attached + enable/disable + library picker)
 *   - Tools   (MCP config + overrides)
 *   - History (last built / last tailored / drift trail)
 *
 * Each tab is an independent component so the slide-over stays under the
 * 150-line component budget.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import SpecialistPromptTab from './SpecialistPromptTab'
import SpecialistSkillsTab from './SpecialistSkillsTab'
import SpecialistToolsTab from './SpecialistToolsTab'
import SpecialistHistoryTab from './SpecialistHistoryTab'

interface SpecialistSlideOverProps {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}

type Tab = 'prompt' | 'skills' | 'tools' | 'history'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'history', label: 'History' }
]

export default function SpecialistSlideOver({
  open,
  onClose,
  workspaceId
}: SpecialistSlideOverProps): React.JSX.Element | null {
  const [activeTab, setActiveTab] = useState<Tab>('prompt')
  const specialist = useProjectSpecialistStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : null
  )

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="Specialist settings"
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <div>
            <h2 className="text-base font-semibold">
              {specialist?.displayName ?? 'Project Specialist'}
            </h2>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {specialist?.buildStatus === 'ready'
                ? `Ready — ${specialist.detectedTechs.length} techs`
                : (specialist?.buildStatus ?? 'not built')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close specialist panel"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <nav
          className="flex gap-1 border-b border-slate-200 px-4 dark:border-slate-700"
          role="tablist"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'px-3 py-2 text-sm font-medium border-b-2 -mb-px',
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-300'
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <section className="flex-1 overflow-y-auto p-4">
          {activeTab === 'prompt' && specialist && (
            <SpecialistPromptTab specialist={specialist} />
          )}
          {activeTab === 'skills' && specialist && (
            <SpecialistSkillsTab specialist={specialist} />
          )}
          {activeTab === 'tools' && specialist && (
            <SpecialistToolsTab specialist={specialist} />
          )}
          {activeTab === 'history' && specialist && (
            <SpecialistHistoryTab specialist={specialist} />
          )}
          {!specialist && (
            <div className="text-sm text-slate-500">
              No Project Specialist for this workspace yet.
            </div>
          )}
        </section>
      </aside>
    </>
  )
}

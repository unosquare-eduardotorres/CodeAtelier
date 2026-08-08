import { useState } from 'react'
import { Brain, FileStack, Radio, Sparkles, FolderDown } from 'lucide-react'

import { SettingsCard } from '@renderer/components/common'
import { useMemoryStore } from '@renderer/store'
import BootstrapKnowledge from '../BootstrapKnowledge'
import IngestDocuments from '../IngestDocuments'
import ReflectionReview from '../ReflectionReview'
import CapturePanel from './CapturePanel'
import ExportPanel from './ExportPanel'
import ThroughputControl from './ThroughputControl'

const SECTIONS = [
  { key: 'bootstrap', label: 'Bootstrap', icon: Brain },
  { key: 'documents', label: 'Documents', icon: FileStack },
  { key: 'capture', label: 'Auto-capture', icon: Radio },
  { key: 'reflection', label: 'Reflection', icon: Sparkles },
  { key: 'export', label: 'Export', icon: FolderDown }
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

interface IngestionTabProps {
  workspaceId: string
  workspacePath: string
  onFeedDocument: () => void
}

/**
 * Ingestion is eight unrelated concerns; stacking them on one scroll made the
 * page ~4000px long and buried Reflection below nine capture toggles. They are
 * now one pane at a time behind a sub-nav.
 */
export default function IngestionTab({
  workspaceId,
  workspacePath,
  onFeedDocument
}: IngestionTabProps): React.JSX.Element {
  const [section, setSection] = useState<SectionKey>('bootstrap')
  const { captureSettings, feedStatus, feedMessage, feedError, updateCaptureSettings } =
    useMemoryStore()

  return (
    <div className="flex flex-1 gap-5 h-full min-h-0">
      {/* Sub-nav */}
      <nav aria-label="Ingestion sections" className="shrink-0 w-40 pt-1">
        <ul className="space-y-0.5">
          {SECTIONS.map(({ key, label, icon: Icon }) => {
            const active = key === section
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  data-testid={`ingestion-section-${key}`}
                  onClick={() => setSection(key)}
                  className={`flex items-center gap-2 w-full h-8 px-2.5 text-xs rounded-md transition-colors
                    focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
                      active
                        ? 'bg-primary-muted text-primary-text'
                        : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
                    }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Pane */}
      <div className="flex-1 min-w-0 min-h-0 overflow-auto pr-1 pb-6">
        {/* BootstrapKnowledge draws its own bordered panels — wrapping it in a
            SettingsCard nested a card inside a card. */}
        {section === 'bootstrap' && (
          <div className="space-y-4">
            <BootstrapKnowledge />
            {captureSettings && (
              <ThroughputControl
                captureSettings={captureSettings}
                onUpdateSettings={updateCaptureSettings}
                workspaceId={workspaceId}
              />
            )}
          </div>
        )}

        {section === 'documents' && (
          <SettingsCard>
            <IngestDocuments
              onFeedDocument={onFeedDocument}
              feedStatus={feedStatus}
              feedMessage={feedMessage}
              feedError={feedError}
            />
          </SettingsCard>
        )}

        {section === 'capture' &&
          (captureSettings ? (
            <CapturePanel
              captureSettings={captureSettings}
              onUpdateSettings={updateCaptureSettings}
              workspaceId={workspaceId}
            />
          ) : (
            <p className="text-xs text-text-muted">Loading capture settings…</p>
          ))}

        {section === 'reflection' && (
          <ReflectionReview
            workspaceId={workspaceId}
            workspacePath={workspacePath}
            enabled={captureSettings?.reflectionEnabled ?? false}
          />
        )}

        {section === 'export' &&
          (captureSettings ? (
            <ExportPanel
              captureSettings={captureSettings}
              onUpdateSettings={updateCaptureSettings}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
            />
          ) : (
            <p className="text-xs text-text-muted">Loading capture settings…</p>
          ))}
      </div>
    </div>
  )
}

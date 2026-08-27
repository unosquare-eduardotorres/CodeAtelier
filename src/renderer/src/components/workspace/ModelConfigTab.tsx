import { useEffect, useRef, useState } from 'react'
import { Activity, SlidersHorizontal } from 'lucide-react'
import { useModelConfig, InUseTab, ConfigureTab } from './model-config'
import { Tabs, type TabItem } from '@renderer/components/common/ui'
import { useSettingsStore } from '@renderer/store/settings.store'

/**
 * The page used to do two jobs through one surface: report what the workspace
 * is running, and edit what it should run. Those questions have opposite
 * answers to "is this editable?", so they are now separate tabs.
 */
type ModelsView = 'in-use' | 'configure'

const VIEW_TABS: TabItem<ModelsView>[] = [
  {
    key: 'in-use',
    label: 'In Use',
    testId: 'models-tab-in-use',
    icon: <Activity size={13} />
  },
  {
    key: 'configure',
    label: 'Configure',
    testId: 'models-tab-configure',
    icon: <SlidersHorizontal size={13} />
  }
]

export default function ModelConfigTab(): React.JSX.Element {
  const config = useModelConfig()
  const [view, setView] = useState<ModelsView>('in-use')

  // ── Deep-link intent: consume and trigger silent oMLX auto-test ──
  const modelsViewIntent = useSettingsStore((s) => s.modelsViewIntent)
  const setModelsViewIntent = useSettingsStore((s) => s.setModelsViewIntent)

  useEffect(() => {
    if (modelsViewIntent) {
      setModelsViewIntent(null)
      // Auto-test oMLX connection on mount (regardless of provider — always useful)
      config.testConnection(undefined, undefined, true)
    }
  }, [modelsViewIntent, setModelsViewIntent, config])

  // ── Unsaved-changes navigation guard (covers the whole Configure tab) ──
  const setUnsavedGuard = useSettingsStore((s) => s.setUnsavedGuard)
  const clearUnsavedGuard = useSettingsStore((s) => s.clearUnsavedGuard)

  const isDirtyRef = useRef(config.isLocalModelsDirty)
  isDirtyRef.current = config.isLocalModelsDirty
  const saveRef = useRef(config.saveLocalModels)
  saveRef.current = config.saveLocalModels
  const discardRef = useRef(config.discardLocalModels)
  discardRef.current = config.discardLocalModels

  useEffect(() => {
    setUnsavedGuard({
      isDirty: () => isDirtyRef.current,
      save: () => saveRef.current(),
      discard: () => discardRef.current()
    })
    return () => clearUnsavedGuard()
  }, [setUnsavedGuard, clearUnsavedGuard])

  if (!config.activeWorkspace) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-secondary">Select a workspace to configure models.</p>
      </div>
    )
  }

  return (
    <div data-testid="model-config-tab" className="w-full pb-8">
      <div className="px-6 pt-6">
        <h2 className="text-base font-semibold text-text-primary mb-1">Model Configuration</h2>
        <p className="text-xs text-text-muted mb-4">
          Default for <span className="font-medium text-text-secondary">new</span> chats — existing
          chats keep their own settings
        </p>

        <div className="border-b border-border-subtle mb-5">
          <Tabs
            items={VIEW_TABS}
            value={view}
            onChange={setView}
            ariaLabel="Model configuration views"
            idPrefix="models-"
          />
        </div>

        {view === 'in-use' ? (
          <InUseTab
            workspaceId={config.activeWorkspace.id}
            refreshKey={config.localModelsSavedAt}
          />
        ) : (
          <ConfigureTab config={config} />
        )}
      </div>
    </div>
  )
}

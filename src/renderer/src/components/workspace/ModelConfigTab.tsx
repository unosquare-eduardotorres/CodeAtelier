import { useEffect, useRef } from 'react'
import {
  useModelConfig,
  ProviderCards,
  RuntimeStatusCard,
  ModelRolesSection,
  ConversationDefaultsSection
} from './model-config'
import { useSettingsStore } from '@renderer/store/settings.store'

export default function ModelConfigTab(): React.JSX.Element {
  const config = useModelConfig()

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

  // ── Unsaved-changes navigation guard (covers the whole Local Models card) ──
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
        <p className="text-xs text-text-muted mb-6">
          Default for <span className="font-medium text-text-secondary">new</span> chats — existing
          chats keep their own settings
        </p>

        {/* ── What the running app is actually using ── */}
        <RuntimeStatusCard
          workspaceId={config.activeWorkspace.id}
          refreshKey={config.localModelsSavedAt}
        />

        {/* ── Provider Connections ── */}
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
            Provider Connections
          </h3>
        </div>
        <ProviderCards
          claudeCliStatus={config.claudeCliStatus}
          openCodeCliStatus={config.openCodeCliStatus}
          localLlmBackend={config.localLlmBackend}
          onBackendChange={config.setLocalLlmBackend}
          localModelsDraft={config.localModelsDraft}
          isLocalModelsDirty={config.isLocalModelsDirty}
          localStatus={config.localStatus}
          connectionTesting={config.connectionTesting}
          modelLoading={config.modelLoading}
          localModel={config.localModel}
          localBaseUrl={config.localBaseUrl}
          isRemoteServer={config.isRemoteServer}
          platformInfo={config.platformInfo}
          onHostChange={config.setLocalHost}
          onPortChange={config.setLocalPort}
          onApiKeyChange={config.setLocalApiKey}
          onContextWindowChange={config.setLocalContextWindow}
          onSaveLocalModels={config.saveLocalModels}
          onDiscardLocalModels={config.discardLocalModels}
          onTestConnection={() => config.testConnection()}
          onAutoTest={config.scheduleAutoTest}
          onLocalModelSelect={config.handleLocalModelSelect}
          onLoadOmlxModel={config.handleLoadOmlxModel}
          onUnloadOmlxModel={config.handleUnloadOmlxModel}
          ollamaEmbeddingModel={config.ollamaEmbeddingModel}
          onOllamaEmbeddingModelChange={config.handleOllamaEmbeddingModelChange}
        />

        {/* ── Model Routing (cross-provider) ── */}
        <ModelRolesSection
          modelRoles={config.modelRoles}
          claudeModelOverrides={config.claudeModelOverrides}
          workspaceProvider={config.derivedProvider}
          omlxModels={config.omlxChatModels}
          onModelRolesChange={config.handleModelRolesChange}
          fallbackModel={config.fallbackModel}
          onFallbackModelChange={config.handleFallbackModelChange}
        />

        {/* ── Workspace Defaults (provider-agnostic, bottom) ── */}
        <ConversationDefaultsSection
          communicationTone={config.communicationTone}
          onToneChange={config.handleToneChange}
        />
      </div>
    </div>
  )
}

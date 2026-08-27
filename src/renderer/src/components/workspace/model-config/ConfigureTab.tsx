/**
 * ConfigureTab — everything editable on the Models page.
 *
 * Grouped by what you are choosing, not by which server it came from, and
 * governed by a single draft: provider connections, the local server, the
 * models it offers, routing, and conversation defaults all land on one Save.
 */

import { useState } from 'react'
import ProviderCards from './ProviderCards'
import ModelRolesSection from './ModelRolesSection'
import ConversationDefaultsSection from './ConversationDefaultsSection'
import SaveBar from './SaveBar'
import type { useModelConfig } from './useModelConfig'

interface ConfigureTabProps {
  config: ReturnType<typeof useModelConfig>
}

export default function ConfigureTab({ config }: ConfigureTabProps): React.JSX.Element {
  const [saving, setSaving] = useState(false)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await config.saveLocalModels()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="model-config-configure">
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
        isEmbeddingModelDirty={config.isEmbeddingModelDirty}
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
        localBackend={config.localLlmBackend}
        onModelRolesChange={config.handleModelRolesChange}
        fallbackModel={config.fallbackModel}
        onFallbackModelChange={config.handleFallbackModelChange}
      />

      {/* ── Workspace Defaults (provider-agnostic, bottom) ── */}
      <ConversationDefaultsSection
        communicationTone={config.communicationTone}
        onToneChange={config.handleToneChange}
      />

      <SaveBar
        changeCount={config.unsavedChangeCount}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={config.discardLocalModels}
      />
    </div>
  )
}

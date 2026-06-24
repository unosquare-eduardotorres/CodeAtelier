import {
  useModelConfig,
  ProviderToggle,
  ExecutorBackendSection,
  ClaudeConfigSection,
  LocalLLMConfigSection
} from './model-config'
import { PresetManager } from './PresetManager'

export default function ModelConfigTab(): React.JSX.Element {
  const config = useModelConfig()

  if (!config.activeWorkspace) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-secondary">Select a workspace to configure models.</p>
      </div>
    )
  }

  return (
    <div data-testid="model-config-tab" className="w-full px-6 py-8">
      {/* Header — full width */}
      <div className="mb-6">
        <h2 className="text-base font-semibold text-text-primary">Model Configuration</h2>
        <p className="text-xs text-text-secondary mt-1">
          Configure which LLM provider and models power this workspace.
        </p>
      </div>

      {/* ── LLM Provider Toggle ── */}
      <ProviderToggle
        provider={config.provider}
        backend={config.backend}
        platformInfo={config.platformInfo}
        onProviderChange={config.handleUnifiedProviderChange}
      />

      {/* ── Executor Backend (advanced, Claude only) ── */}
      {config.provider === 'claude' && (
        <ExecutorBackendSection
          executorBackend={config.executorBackend}
          activeWorkspaceId={config.activeWorkspace.id}
          onBackendChange={async (backend) => {
            config.setExecutorBackend(backend)
            try {
              const settings = await window.api.getWorkspaceSettings({
                workspaceId: config.activeWorkspace!.id
              })
              await window.api.updateWorkspaceSettings({
                workspaceId: config.activeWorkspace!.id,
                settings: { ...settings, executorBackend: backend }
              })
            } catch (err) {
              console.error('Failed to save executor backend:', err)
            }
          }}
        />
      )}

      {/* ── Claude-specific config ── */}
      {config.provider === 'claude' && (
        <ClaudeConfigSection
          costPreference={config.costPreference}
          fastMode={config.fastMode}
          budgetCapUsd={config.budgetCapUsd}
          communicationTone={config.communicationTone}
          onCostPreferenceChange={config.handleCostPreferenceChange}
          onFastModeToggle={config.handleFastModeToggle}
          onBudgetCapChange={config.handleBudgetCapChange}
          onToneChange={config.handleToneChange}
        />
      )}

      {/* ── Local LLM configuration ── */}
      {config.provider === 'local-llm' && (
        <LocalLLMConfigSection
          backend={config.backend}
          platformInfo={config.platformInfo}
          localHost={config.localHost}
          localPort={config.localPort}
          localApiKey={config.localApiKey}
          localContextWindow={config.localContextWindow}
          localStatus={config.localStatus}
          connectionTesting={config.connectionTesting}
          modelLoading={config.modelLoading}
          localModel={config.localModel}
          localBaseUrl={config.localBaseUrl}
          isRemoteServer={config.isRemoteServer}
          showOllamaSetup={config.showOllamaSetup}
          provider={config.provider}
          activeWorkspaceId={config.activeWorkspace.id}
          onBackendChange={config.handleBackendChange}
          onLocalModelSelect={config.handleLocalModelSelect}
          onLoadOmlxModel={config.handleLoadOmlxModel}
          onUnloadOmlxModel={config.handleUnloadOmlxModel}
          onTestConnection={() => config.testConnection()}
          onAutoTest={config.scheduleAutoTest}
          onHostChange={config.setLocalHost}
          onPortChange={config.setLocalPort}
          onApiKeyChange={config.setLocalApiKey}
          onContextWindowChange={config.setLocalContextWindow}
          onShowOllamaSetupChange={config.setShowOllamaSetup}
          saveProviderSettings={config.saveProviderSettings}
          setProvider={config.setProvider}
          setLocalModel={config.setLocalModel}
        />
      )}

      {/* ── LLM Presets ── */}
      <PresetManager />
    </div>
  )
}

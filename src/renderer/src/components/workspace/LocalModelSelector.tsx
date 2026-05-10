import { useState } from 'react'
import {
  Check,
  Download,
  Star,
  Cpu,
  Sparkles,
  ExternalLink,
  Copy,
  ChevronRight,
  Loader2,
  Power
} from 'lucide-react'
import { RECOMMENDED_LOCAL_MODELS, resolveModelId } from '../../../../shared/constants'
import type {
  LocalLLMBackend,
  MemoryTier,
  OmlxModelDetail,
  RecommendedLocalModel
} from '../../../../shared/types'

interface LocalModelSelectorProps {
  selectedModel: string
  installedModels: string[]
  /** All models from oMLX admin API (downloaded + loaded). Undefined when admin API unavailable. */
  downloadedModels?: OmlxModelDetail[]
  backend: LocalLLMBackend
  onSelect: (modelId: string) => void
  onPull: (modelId: string) => void
  /** Load a downloaded model into memory (oMLX admin API) */
  onLoadModel?: (modelId: string) => Promise<void>
  /** For oMLX: copy model name to clipboard + open downloader tab */
  onCopyAndOpenDownloader?: (modelName: string) => void
}

const TIER_CONFIG: { key: MemoryTier; label: string; icon: string; color: string }[] = [
  { key: '8gb', label: '8 GB RAM', icon: '🟢', color: 'text-green-400' },
  { key: '16gb', label: '16 GB RAM', icon: '🟡', color: 'text-yellow-400' },
  { key: '32gb', label: '32 GB RAM', icon: '🔵', color: 'text-blue-400' },
  { key: '48gb+', label: '48+ GB RAM', icon: '🟣', color: 'text-purple-400' }
]

const TOOL_CALLING_COLORS: Record<string, string> = {
  basic: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20',
  good: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  native: 'text-green-400 bg-green-500/10 border-green-500/20',
  excellent: 'text-purple-400 bg-purple-500/10 border-purple-500/20'
}

function isModelInstalled(modelId: string, installedModels: string[]): boolean {
  return installedModels.some(
    (m) => m === modelId || m === `${modelId}:latest` || m.startsWith(`${modelId}:`)
  )
}

function ModelRow({
  model,
  installed,
  selected,
  backend,
  isDownloaded,
  isLoadingModel,
  onSelect,
  onAction,
  onLoad
}: {
  model: RecommendedLocalModel
  installed: boolean
  selected: boolean
  backend: LocalLLMBackend
  /** Model is on disk but not loaded (oMLX admin API) */
  isDownloaded?: boolean
  /** Model is currently being loaded */
  isLoadingModel?: boolean
  onSelect: () => void
  onAction: () => void
  onLoad?: () => void
}): React.JSX.Element {
  return (
    <div
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors ${
        selected
          ? 'border-primary bg-primary-muted'
          : 'border-border-subtle hover:bg-surface-overlay'
      }`}
    >
      {/* Model info — left side */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-primary truncate">{model.label}</span>
          {model.recommended && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary-muted text-primary-text font-medium">
              <Star size={8} />
              Recommended
            </span>
          )}
          {model.mlxOptimized && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-medium">
              <Sparkles size={8} />
              MLX
            </span>
          )}
          <span
            className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${TOOL_CALLING_COLORS[model.toolCalling]}`}
          >
            <Cpu size={8} />
            Tools: {model.toolCalling}
          </span>
        </div>
        <p className="text-xs text-text-secondary mt-0.5">{model.description}</p>
        <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted">
          <span>{model.parameterSize}</span>
          {model.activeParams && <span>Active: {model.activeParams}</span>}
          <span>{(model.contextWindow / 1024).toFixed(0)}K ctx</span>
          {model.quantization && <span>{model.quantization}</span>}
        </div>
      </div>

      {/* Action button — right side */}
      <div className="ml-3 shrink-0">
        {installed ? (
          <button
            onClick={onSelect}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              selected
                ? 'bg-primary text-white'
                : 'border border-border-default hover:bg-surface-hover text-text-secondary'
            }`}
          >
            {selected ? (
              <>
                <Check size={12} />
                Selected
              </>
            ) : (
              'Select'
            )}
          </button>
        ) : isDownloaded && onLoad ? (
          <button
            onClick={onLoad}
            disabled={isLoadingModel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-primary text-primary hover:bg-primary-muted transition-colors disabled:opacity-50"
          >
            {isLoadingModel ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Loading…
              </>
            ) : (
              <>
                <Power size={12} />
                Load
              </>
            )}
          </button>
        ) : backend === 'omlx' ? (
          <button
            onClick={onAction}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border-default hover:bg-surface-hover text-text-secondary transition-colors"
          >
            <Copy size={12} />
            Copy & Download
            <ExternalLink size={10} />
          </button>
        ) : (
          <button
            onClick={onAction}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border-default hover:bg-surface-hover text-text-secondary transition-colors"
          >
            <Download size={12} />
            Pull
          </button>
        )}
      </div>
    </div>
  )
}

export default function LocalModelSelector({
  selectedModel,
  installedModels,
  downloadedModels,
  backend,
  onSelect,
  onPull,
  onLoadModel,
  onCopyAndOpenDownloader
}: LocalModelSelectorProps): React.JSX.Element {
  const [customModel, setCustomModel] = useState('')
  const [recommendationsOpen, setRecommendationsOpen] = useState(false)
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null)

  /** Resolve the display/selection model ID for the active backend */
  const getModelId = (model: RecommendedLocalModel): string => resolveModelId(model, backend)

  const tiers = TIER_CONFIG.map((tier) => ({
    ...tier,
    models: RECOMMENDED_LOCAL_MODELS.filter((m) => {
      if (m.memoryTier !== tier.key) return false
      // Hide models without an oMLX variant when oMLX is selected
      if (backend === 'omlx' && !m.omlxId) return false
      return true
    })
  }))

  const handleCustomModelSelect = (): void => {
    if (customModel.trim()) {
      onSelect(customModel.trim())
    }
  }

  /** Check if a model is downloaded (on disk) but not yet loaded into memory */
  const isModelDownloaded = (modelId: string): boolean => {
    if (!downloadedModels) return false
    return downloadedModels.some((m) => m.id === modelId && !m.loaded)
  }

  /** Get admin API detail for a model (if available) */
  const getDownloadedModel = (modelId: string): OmlxModelDetail | undefined => {
    return downloadedModels?.find((m) => m.id === modelId)
  }

  /** Handle loading a downloaded model into memory */
  const handleLoadModel = async (modelId: string): Promise<void> => {
    if (!onLoadModel) return
    setLoadingModelId(modelId)
    try {
      await onLoadModel(modelId)
    } finally {
      setLoadingModelId(null)
    }
  }

  /** Handle "not installed" action — oMLX copies+downloads, Ollama triggers pull */
  const handleNotInstalled = (model: RecommendedLocalModel): void => {
    const modelId = getModelId(model)
    if (backend === 'omlx' && onCopyAndOpenDownloader) {
      onCopyAndOpenDownloader(modelId)
    } else {
      onPull(modelId)
    }
  }

  return (
    <div className="space-y-4">
      {/* Section A: Installed Models (always visible, primary) */}
      <div>
        <label className="text-xs font-medium text-text-secondary">Model</label>
        {installedModels.length > 0 ? (
          <div className="space-y-1.5 mt-2">
            {installedModels.map((modelId) => (
              <button
                key={modelId}
                onClick={() => onSelect(modelId)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                  selectedModel === modelId
                    ? 'border-primary bg-primary-muted'
                    : 'border-border-subtle hover:bg-surface-overlay'
                }`}
              >
                <div className="flex items-center gap-2">
                  {selectedModel === modelId ? (
                    <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                      <Check size={10} className="text-white" />
                    </div>
                  ) : (
                    <div className="w-4 h-4 rounded-full border-2 border-border-default" />
                  )}
                  <span className="text-sm font-medium text-text-primary">{modelId}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-medium">
                    loaded
                  </span>
                  {/* Show estimated size from admin API if available */}
                  {(() => {
                    const detail = getDownloadedModel(modelId)
                    return detail ? (
                      <span className="text-[10px] text-text-muted">{detail.estimatedSize}</span>
                    ) : null
                  })()}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-muted mt-2">
            No models loaded. Download one from the recommendations below, or enter a custom model
            name.
          </p>
        )}

        {/* Downloaded-but-not-loaded models (oMLX admin API) */}
        {downloadedModels && downloadedModels.filter((m) => !m.loaded).length > 0 && (
          <div className="mt-3">
            <label className="text-xs font-medium text-text-muted">Downloaded (not loaded)</label>
            <div className="space-y-1.5 mt-1.5">
              {downloadedModels
                .filter((m) => !m.loaded)
                .map((model) => (
                  <div
                    key={model.id}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border-subtle hover:bg-surface-overlay transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Power size={14} className="text-text-muted shrink-0" />
                      <span className="text-sm font-medium text-text-primary truncate">
                        {model.id}
                      </span>
                      <span className="text-[10px] text-text-muted shrink-0">
                        {model.estimatedSize}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-overlay text-text-muted font-medium shrink-0">
                        on disk
                      </span>
                    </div>
                    <button
                      onClick={() => handleLoadModel(model.id)}
                      disabled={model.isLoading || loadingModelId === model.id}
                      className="ml-2 shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-primary text-primary hover:bg-primary-muted transition-colors disabled:opacity-50"
                    >
                      {model.isLoading || loadingModelId === model.id ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          Loading…
                        </>
                      ) : (
                        <>
                          <Power size={12} />
                          Load
                        </>
                      )}
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Custom model input */}
        <div className="mt-3">
          <label className="text-xs font-medium text-text-muted">Custom model</label>
          <div className="flex gap-2 mt-1">
            <input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomModelSelect()}
              placeholder={
                backend === 'omlx' ? 'e.g. mlx-community/Qwen3-30B-A3B-4bit' : 'e.g. mistral:latest'
              }
              className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button
              onClick={handleCustomModelSelect}
              disabled={!customModel.trim()}
              className="px-3 py-1.5 text-xs font-medium bg-surface-hover hover:bg-surface-base text-text-body rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Use
            </button>
          </div>
        </div>
      </div>

      {/* Section B: Recommended Models (collapsed by default) */}
      <details
        open={recommendationsOpen}
        onToggle={(e) => setRecommendationsOpen((e.target as HTMLDetailsElement).open)}
        className="pt-4 border-t border-border-subtle"
      >
        <summary className="cursor-pointer text-sm font-medium text-text-secondary hover:text-text-primary select-none list-none flex items-center gap-2 py-2">
          <ChevronRight
            size={16}
            className={`transition-transform duration-200 ${recommendationsOpen ? 'rotate-90' : ''}`}
          />
          <span>Recommended Models</span>
          <span className="text-xs text-text-muted font-normal ml-1">
            — browse by RAM tier
          </span>
        </summary>
        <div className="mt-3 space-y-4">
          {tiers.map((tier) => (
            <div key={tier.key}>
              <h4 className="text-xs font-medium text-text-muted mb-2 flex items-center gap-1.5">
                <span>{tier.icon}</span>
                <span>{tier.label}</span>
              </h4>
              <div className="space-y-1.5">
                {tier.models.map((model) => {
                  const modelId = getModelId(model)
                  return (
                    <ModelRow
                      key={modelId}
                      model={model}
                      installed={isModelInstalled(modelId, installedModels)}
                      selected={selectedModel === modelId}
                      backend={backend}
                      isDownloaded={isModelDownloaded(modelId)}
                      isLoadingModel={loadingModelId === modelId}
                      onSelect={() => onSelect(modelId)}
                      onAction={() => handleNotInstalled(model)}
                      onLoad={() => handleLoadModel(modelId)}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

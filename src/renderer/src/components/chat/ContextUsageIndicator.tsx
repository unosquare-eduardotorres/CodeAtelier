import { useState } from 'react'
import { useChatStore } from '@renderer/store'
import { CompactContextModal } from '@renderer/components/common'
import type { ContextUsageLevel } from '../../../../shared/types'

const LEVEL_STYLES: Record<ContextUsageLevel, string> = {
  green: 'text-success/70 hover:text-success',
  yellow: 'text-warning/70 hover:text-warning',
  red: 'text-danger/70 hover:text-danger',
  critical: 'text-danger hover:text-danger animate-pulse'
}

const DOT_STYLES: Record<ContextUsageLevel, string> = {
  green: 'bg-success/60',
  yellow: 'bg-warning/60',
  red: 'bg-danger/60',
  critical: 'bg-danger animate-pulse'
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

interface ContextUsageIndicatorProps {
  conversationId: string
}

export default function ContextUsageIndicator({
  conversationId
}: ContextUsageIndicatorProps): React.JSX.Element | null {
  const usage = useChatStore((s) => s.contextUsages[conversationId])
  const llmProvider = useChatStore((s) =>
    s.activeConversation?.id === conversationId ? s.activeConversation.llmProvider : undefined
  )
  const [modalOpen, setModalOpen] = useState(false)

  // Don't render until we have real usage data
  if (!usage || usage.percentage <= 0) return null

  const { inputTokens, contextWindowSize, level, percentage } = usage
  const textStyle = LEVEL_STYLES[level]
  const dotStyle = DOT_STYLES[level]

  const handleCompact = async (extractNuance: boolean): Promise<void> => {
    setModalOpen(false)
    try {
      await window.api.compactConversation({ extractNuance })
    } catch {
      // Compaction errors are surfaced by the streaming layer
    }
  }

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono tabular-nums transition-colors cursor-pointer ${textStyle}`}
        title={`Context usage: ${percentage}% — click for details`}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotStyle}`} />
        {fmtTokens(inputTokens)} / {fmtTokens(contextWindowSize)}
      </button>

      <CompactContextModal
        isOpen={modalOpen}
        inputTokens={inputTokens}
        contextWindowSize={contextWindowSize}
        level={level}
        categories={usage.categories}
        breakdown={usage.breakdown}
        isLocalProvider={llmProvider === 'local-llm'}
        onExtractNuance={() => handleCompact(true)}
        onQuickCompact={() => handleCompact(false)}
        onCancel={() => setModalOpen(false)}
      />
    </>
  )
}

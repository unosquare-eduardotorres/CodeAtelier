/**
 * SystemPromptSection — Markdown prompt preview with edit/rebuild buttons.
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { remarkStripStrayBackticks } from '../../chat/remark-plugins'
import { Pencil, RefreshCw } from 'lucide-react'
import { PromptPreviewModal } from '@renderer/components/specialist'

// ── Types ────────────────────────────────────────────────────────────────────

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

interface SystemPromptSectionProps {
  prompt: string
  editedPrompt: string
  rebuildState: RebuildState
  promptModalOpen: boolean
  savingPrompt: boolean
  onOpenModal: () => void
  onCloseModal: () => void
  onRebuildPrompt: () => void
  onSavePrompt: (newPrompt: string) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function SystemPromptSection({
  prompt,
  editedPrompt,
  rebuildState,
  promptModalOpen,
  savingPrompt,
  onOpenModal,
  onCloseModal,
  onRebuildPrompt,
  onSavePrompt
}: SystemPromptSectionProps): React.JSX.Element {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
          System Prompt
        </h4>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">
            {editedPrompt.length.toLocaleString()} chars
          </span>
          <button
            onClick={onOpenModal}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors"
            title="Edit raw prompt"
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            onClick={onRebuildPrompt}
            disabled={rebuildState === 'building'}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors disabled:opacity-40"
            title="Rebuild prompt using LLM"
          >
            <RefreshCw size={12} className={rebuildState === 'building' ? 'animate-spin' : ''} />
            Rebuild
          </button>
        </div>
      </div>

      {/* Rendered markdown preview */}
      <div className="bg-surface-overlay border border-border-subtle rounded-xl p-6 max-h-[70vh] overflow-y-auto">
        <div
          className="prose prose-sm max-w-none [&]:max-w-none
            prose-headings:text-text-primary prose-headings:font-semibold
            prose-p:text-text-body prose-strong:text-text-primary
            prose-code:text-code-text prose-code:bg-surface-base prose-code:px-1 prose-code:rounded
            prose-ul:text-text-body prose-li:text-text-body
            prose-a:text-accent"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}
            rehypePlugins={[rehypeRaw]}
          >
            {prompt || '*No prompt generated yet. Click Rebuild to generate.*'}
          </ReactMarkdown>
        </div>
      </div>

      {/* Edit Prompt Modal */}
      <PromptPreviewModal
        open={promptModalOpen}
        prompt={editedPrompt}
        onSave={onSavePrompt}
        onClose={onCloseModal}
        isSaving={savingPrompt}
      />
    </section>
  )
}

// @ts-nocheck — TODO: fix after blueprint refactoring
import type { JSX } from 'react'
import { FolderOpen } from 'lucide-react'
import { AttachmentDropzone } from '@renderer/components/chat'
import { ReferenceDocList } from '.'
import type { ReferenceDocument } from '../../../../../shared/blueprint-types'

interface BlueprintInputViewProps {
  title: string
  description: string
  referenceDocuments: ReferenceDocument[]
  onTitleChange: (v: string) => void
  onDescriptionChange: (v: string) => void
  onAttachments: (paths: string[]) => void
  onRemoveDoc: (index: number) => void
  onBrowseFiles: () => void
  onBack: () => void
  onStart: () => void
}

export default function BlueprintInputView({
  title,
  description,
  referenceDocuments,
  onTitleChange,
  onDescriptionChange,
  onAttachments,
  onRemoveDoc,
  onBrowseFiles,
  onBack,
  onStart
}: BlueprintInputViewProps): JSX.Element {
  return (
    <div data-testid="blueprint-input-view" className="max-w-3xl mx-auto w-full bg-surface-raised rounded-xl border border-border-subtle p-5 space-y-4 flex flex-col min-h-[calc(100vh-200px)]">
      <h4 className="text-sm font-semibold text-text-primary">New Blueprint</h4>

      <div className="space-y-3 flex-1 flex flex-col">
        {/* Title */}
        <div>
          <label className="text-xs font-medium text-text-secondary block mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g., Add user notification preferences page"
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
            autoFocus
          />
        </div>

        {/* Description with drag-and-drop attachments */}
        <div className="flex-1 flex flex-col min-h-0">
          <label className="text-xs font-medium text-text-secondary block mb-1">
            Description{' '}
            <span className="text-text-muted">(optional — paste URLs to auto-link)</span>
          </label>
          <AttachmentDropzone
            attachments={referenceDocuments
              .filter((d) => d.type === 'file')
              .map((d) => d.path)}
            onAttachmentsChange={onAttachments}
            conversationId="blueprint-input"
            hideChips
          >
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Describe the feature in detail. Include requirements, constraints, and any relevant context... Drop files here or paste URLs."
              rows={8}
              className="flex-1 w-full bg-transparent text-sm text-text-primary placeholder-text-muted resize-none focus:outline-none leading-relaxed min-h-[200px]"
            />
          </AttachmentDropzone>
        </div>

        {/* Attachment Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBrowseFiles}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary bg-surface-base border border-border-subtle rounded-lg hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            <FolderOpen size={13} />
            Browse Files
          </button>
        </div>

        {/* Reference Documents List */}
        {referenceDocuments.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-secondary block">
              Reference Documents ({referenceDocuments.length})
            </label>
            <ReferenceDocList documents={referenceDocuments} onRemove={onRemoveDoc} />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={!title.trim()}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Start Pipeline
        </button>
      </div>
    </div>
  )
}

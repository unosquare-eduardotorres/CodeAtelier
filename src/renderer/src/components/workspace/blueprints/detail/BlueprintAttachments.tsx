/**
 * BlueprintAttachments — read-only view of the reference documents a blueprint
 * was created with.
 *
 * The attachments live in `settingsJson.referenceDocuments` and were previously
 * invisible once the blueprint existed: the input form showed them, the detail
 * view did not. That mattered most for Jira-imported blueprints, where the
 * screenshots are the whole point of the ticket.
 *
 * Images render as thumbnails (click for the lightbox); everything else falls
 * through to the same grouped chip list the input form uses.
 */

import type { JSX } from 'react'
import { Paperclip } from 'lucide-react'
import type { ReferenceDocument } from '../../../../../../shared/blueprint-types'
import ReferenceDocList from '../ReferenceDocList'
import ImagePreviewThumbnail from '../../../chat/ImagePreviewThumbnail'
import { partitionImages } from './reference-docs'

interface BlueprintAttachmentsProps {
  documents: ReferenceDocument[]
}

export function BlueprintAttachments({ documents }: BlueprintAttachmentsProps): JSX.Element | null {
  if (documents.length === 0) return null

  const { images, rest } = partitionImages(documents)

  return (
    <div
      data-testid="blueprint-attachments"
      className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <Paperclip size={13} className="text-accent" />
        <span className="text-xs font-semibold text-text-primary">
          Attachments ({documents.length})
        </span>
      </div>

      {images.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {images.map((doc, i) => (
            <ImagePreviewThumbnail key={`${doc.path}-${i}`} filePath={doc.path} />
          ))}
        </div>
      )}

      {rest.length > 0 && <ReferenceDocList documents={rest} readonly />}
    </div>
  )
}

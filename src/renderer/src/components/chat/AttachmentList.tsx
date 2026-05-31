/**
 * AttachmentList — renders image and file attachments within a message bubble.
 * Extracted from MessageBubble.
 */

import React, { useState, useEffect } from 'react'
import { Paperclip } from 'lucide-react'
import { ImageLightbox, Skeleton } from '@renderer/components/common'

// ── BubbleImage (image attachment with lightbox) ──

function BubbleImage({ filePath }: { filePath: string }): React.JSX.Element {
  const [dataUri, setDataUri] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .readImageBase64({ filePath })
      .then((uri) => {
        if (!cancelled) setDataUri(uri)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [filePath])

  return (
    <>
      {dataUri ? (
        <img
          src={dataUri}
          alt={filePath.split('/').pop() || 'attachment'}
          className="max-w-[240px] max-h-[180px] rounded-lg border border-border-subtle object-contain cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => setLightboxOpen(true)}
        />
      ) : (
        <Skeleton className="w-[240px] h-[180px] rounded-lg" />
      )}
      {lightboxOpen && dataUri && (
        <ImageLightbox src={dataUri} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

// ── AttachmentList ──

interface AttachmentListProps {
  imageAttachments: string[]
  fileAttachments: string[]
}

export default function AttachmentList({
  imageAttachments,
  fileAttachments
}: AttachmentListProps): React.JSX.Element | null {
  if (imageAttachments.length === 0 && fileAttachments.length === 0) return null

  return (
    <>
      {/* Image attachments */}
      {imageAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {imageAttachments.map((path, idx) => (
            <BubbleImage key={idx} filePath={path} />
          ))}
        </div>
      )}

      {/* File attachments */}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {fileAttachments.map((path, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-overlay text-xs text-text-secondary"
            >
              <Paperclip size={10} />
              {path.split('/').pop() || path}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

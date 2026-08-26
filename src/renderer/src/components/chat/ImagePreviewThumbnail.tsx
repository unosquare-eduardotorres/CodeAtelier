import { useState, useEffect } from 'react'
import { X, ImageOff } from 'lucide-react'
import { ImageLightbox, Skeleton } from '@renderer/components/common'

interface ImagePreviewThumbnailProps {
  filePath: string
  /** Omit to render a read-only thumbnail (still opens the lightbox). */
  onRemove?: () => void
}

export default function ImagePreviewThumbnail({
  filePath,
  onRemove
}: ImagePreviewThumbnailProps): React.JSX.Element {
  const [dataUri, setDataUri] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .readImageBase64({ filePath })
      .then((uri) => {
        if (cancelled) return
        setDataUri(uri)
        setFailed(false)
      })
      .catch((err) => {
        console.error(err)
        if (cancelled) return
        setDataUri(null)
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  return (
    <>
      <div data-testid="attachment-thumbnail" className="relative group">
        {dataUri ? (
          <img
            src={dataUri}
            alt="Preview"
            className="w-20 h-20 rounded-lg object-cover cursor-pointer border border-border-subtle hover:border-primary/50 transition-colors"
            onClick={() => setLightboxOpen(true)}
          />
        ) : failed ? (
          <div
            data-testid="attachment-thumbnail-failed"
            title={`Could not load image: ${filePath}`}
            className="w-20 h-20 rounded-lg border border-border-subtle bg-surface-raised flex items-center justify-center text-text-muted"
          >
            <ImageOff size={20} />
          </div>
        ) : (
          <Skeleton className="w-20 h-20 rounded-lg" />
        )}
        {onRemove && (
          <button
            data-testid="attachment-remove-btn"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-danger text-white opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Remove image"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {lightboxOpen && dataUri && (
        <ImageLightbox src={dataUri} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

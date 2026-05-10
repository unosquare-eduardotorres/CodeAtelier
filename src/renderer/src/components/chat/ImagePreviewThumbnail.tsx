import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { ImageLightbox, Skeleton } from '@renderer/components/common'

interface ImagePreviewThumbnailProps {
  filePath: string
  onRemove: () => void
}

export default function ImagePreviewThumbnail({
  filePath,
  onRemove
}: ImagePreviewThumbnailProps): React.JSX.Element {
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
      <div className="relative group">
        {dataUri ? (
          <img
            src={dataUri}
            alt="Preview"
            className="w-20 h-20 rounded-lg object-cover cursor-pointer border border-border-subtle hover:border-primary/50 transition-colors"
            onClick={() => setLightboxOpen(true)}
          />
        ) : (
          <Skeleton className="w-20 h-20 rounded-lg" />
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-danger text-white opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Remove image"
        >
          <X size={12} />
        </button>
      </div>
      {lightboxOpen && dataUri && (
        <ImageLightbox src={dataUri} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

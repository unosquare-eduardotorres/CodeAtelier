import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Paperclip, X } from 'lucide-react'
import type React from 'react'
import { useClipboardImagePaste, MAX_IMAGE_ATTACHMENTS, IMAGE_REGEX } from '@renderer/hooks'
import ImagePreviewThumbnail from './ImagePreviewThumbnail'

interface AttachmentDropzoneProps {
  attachments: string[]
  /**
   * Accepts a functional updater so async paste callbacks apply against the
   * latest state — a plain array snapshot goes stale on rapid pastes and the
   * first image gets silently overwritten. All call sites pass a React setter.
   */
  onAttachmentsChange: (next: string[] | ((prev: string[]) => string[])) => void
  conversationId: string
  children: React.ReactNode
}

const ACCEPTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.sql',
  '.yml',
  '.yaml',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.doc',
  '.docx'
]

export default function AttachmentDropzone({
  attachments,
  onAttachmentsChange,
  conversationId,
  children
}: AttachmentDropzoneProps): React.JSX.Element {
  const imageCount = attachments.filter((p) => IMAGE_REGEX.test(p)).length

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newPaths = acceptedFiles.map((f) => window.api.getPathForFile(f)).filter(Boolean)

      // Enforce image limit on dropped files
      let currentImageCount = imageCount
      const allowed: string[] = []
      for (const p of newPaths) {
        if (IMAGE_REGEX.test(p)) {
          if (currentImageCount >= MAX_IMAGE_ATTACHMENTS) continue
          currentImageCount++
        }
        allowed.push(p)
      }

      onAttachmentsChange([...attachments, ...allowed])
    },
    [attachments, onAttachmentsChange, imageCount]
  )

  const handleImageSaved = useCallback(
    (filePath: string) => {
      onAttachmentsChange((prev) => [...prev, filePath])
    },
    [onAttachmentsChange]
  )

  const handlePaste = useClipboardImagePaste({
    conversationId,
    imageCount,
    onImageSaved: handleImageSaved
  })

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    accept: ACCEPTED_EXTENSIONS.reduce(
      (acc, ext) => {
        acc[`text/${ext.slice(1)}`] = [ext]
        return acc
      },
      {} as Record<string, string[]>
    )
  })

  const removeAttachment = (index: number): void => {
    onAttachmentsChange(attachments.filter((_, i) => i !== index))
  }

  const getFileName = (path: string): string => {
    return path.split('/').pop() || path.split('\\').pop() || path
  }

  // Separate images from other files for rendering
  const imageAttachments: { path: string; idx: number }[] = []
  const fileAttachments: { path: string; idx: number }[] = []
  attachments.forEach((path, idx) => {
    if (IMAGE_REGEX.test(path)) {
      imageAttachments.push({ path, idx })
    } else {
      fileAttachments.push({ path, idx })
    }
  })

  return (
    <div
      {...getRootProps()}
      onPaste={handlePaste}
      data-testid="attachment-dropzone"
      className={`relative rounded-xl transition-colors ${
        isDragActive
          ? 'border border-primary bg-primary-muted border-dashed'
          : 'border border-border-subtle bg-surface-overlay'
      }`}
    >
      <input {...getInputProps()} />

      {isDragActive && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-primary-muted border-2 border-dashed border-primary z-10">
          <p className="text-sm text-primary-text font-medium">Drop files here...</p>
        </div>
      )}

      {/* Image preview thumbnails */}
      {imageAttachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          {imageAttachments.map(({ path, idx }) => (
            <ImagePreviewThumbnail
              key={idx}
              filePath={path}
              onRemove={() => removeAttachment(idx)}
            />
          ))}
          <span
            className={`text-xs ${
              imageCount >= MAX_IMAGE_ATTACHMENTS ? 'text-warning' : 'text-text-secondary'
            }`}
          >
            {imageCount}/{MAX_IMAGE_ATTACHMENTS} images
          </span>
        </div>
      )}

      {/* Non-image file chips */}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {fileAttachments.map(({ path, idx }) => (
            <span
              key={idx}
              data-testid="attachment-chip"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-raised text-xs text-text-secondary"
            >
              <Paperclip size={10} />
              <span className="max-w-[120px] truncate">{getFileName(path)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeAttachment(idx)
                }}
                className="ml-0.5 hover:text-danger transition-colors"
                aria-label={`Remove ${getFileName(path)}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="flex items-end px-3 pb-3 pt-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            open()
          }}
          className="flex-shrink-0 p-2 rounded-lg hover:bg-surface-raised text-text-muted hover:text-text-secondary transition-colors mr-1"
          aria-label="Attach files"
          title="Attach files"
        >
          <Paperclip size={16} />
        </button>
        {children}
      </div>
    </div>
  )
}

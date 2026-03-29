import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Paperclip, X } from 'lucide-react'
import type React from 'react'

interface AttachmentDropzoneProps {
  attachments: string[]
  onAttachmentsChange: (attachments: string[]) => void
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
  children
}: AttachmentDropzoneProps): React.JSX.Element {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newPaths = acceptedFiles.map((f) => (f as File & { path: string }).path).filter(Boolean)
      onAttachmentsChange([...attachments, ...newPaths])
    },
    [attachments, onAttachmentsChange]
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) continue

          // Convert to data URL and save via IPC
          const reader = new FileReader()
          reader.onload = async (): Promise<void> => {
            try {
              const dataUrl = reader.result as string
              const filePath = await window.api.saveClipboardImage({ dataUrl })
              onAttachmentsChange([...attachments, filePath])
            } catch (error) {
              console.error('Failed to save clipboard image:', error)
            }
          }
          reader.readAsDataURL(blob)
          return // Only handle first image
        }
      }
    },
    [attachments, onAttachmentsChange]
  )

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

  return (
    <div
      {...getRootProps()}
      onPaste={handlePaste}
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

      {/* Attached file chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((path, idx) => {
            const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(path)
            return (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-surface-raised text-xs text-text-secondary"
              >
                {isImage ? (
                  <img
                    src={`file://${path}`}
                    alt="attachment"
                    className="w-6 h-6 rounded object-cover"
                  />
                ) : (
                  <Paperclip size={10} />
                )}
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
            )
          })}
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

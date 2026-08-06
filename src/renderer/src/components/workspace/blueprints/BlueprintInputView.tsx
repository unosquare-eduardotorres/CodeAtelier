/**
 * BlueprintInputView — rich input form for creating new blueprints.
 *
 * Two-column layout:
 *  - Left (2/3): Title + large-paste description editor with expand modal
 *  - Right (1/3): Dedicated AttachmentZone drop panel
 *
 * Features:
 *  - Auto-growing description textarea (up to 55vh) with internal scroll
 *  - Footer meta row: word/char count when >500 chars
 *  - Expand button → full-screen modal editor with monospace toggle
 *  - "Large paste captured ✓" flash on paste >2k chars
 *  - Dedicated drop zone panel with supported format chips
 *  - URL auto-detection from pasted description text
 *  - Clipboard image paste
 */

import { useState, useCallback, useRef, useEffect, type JSX } from 'react'
import { useDropzone } from 'react-dropzone'
import { Paperclip, Link2, Upload, Maximize2, X, Check } from 'lucide-react'
import type { ReferenceDocument } from '../../../../../shared/blueprint-types'
import { useClipboardImagePaste, MAX_IMAGE_ATTACHMENTS, IMAGE_REGEX } from '@renderer/hooks'
import { extractUrls, mergeUrlRefs } from './url-detector'
import ReferenceDocList from './ReferenceDocList'
import ImagePreviewThumbnail from '../../chat/ImagePreviewThumbnail'

// ── Constants ──

/** userData/chat-images/<scope>/ dir for images pasted into the blueprint form */
const BLUEPRINT_IMAGE_SCOPE = 'blueprint-input'

const LARGE_PASTE_THRESHOLD = 2000
const CHAR_COUNT_THRESHOLD = 500

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
  '.docx',
  '.html',
  '.xml',
  '.toml',
  '.env',
  '.sh',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.css',
  '.scss'
]

const SUPPORTED_FORMAT_CHIPS = [
  { label: 'PDF', color: 'text-red-400 border-red-400/30' },
  { label: 'Word', color: 'text-blue-400 border-blue-400/30' },
  { label: 'Markdown', color: 'text-violet-400 border-violet-400/30' },
  { label: 'Images', color: 'text-cyan-400 border-cyan-400/30' },
  { label: 'Code', color: 'text-emerald-400 border-emerald-400/30' },
  { label: 'CSV/JSON', color: 'text-green-400 border-green-400/30' }
]

// ── Props ──

interface BlueprintInputViewProps {
  onStart: (params: {
    title: string
    description?: string
    settingsJson?: Record<string, unknown>
  }) => void
  onBack: () => void
  /** Pre-filled title (e.g. from onboard flow) */
  initialTitle?: string
  /** Pre-filled description */
  initialDescription?: string
}

// ── Component ──

export function BlueprintInputView({
  onStart,
  onBack,
  initialTitle = '',
  initialDescription = ''
}: BlueprintInputViewProps): JSX.Element {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [referenceDocs, setReferenceDocs] = useState<ReferenceDocument[]>([])
  const [imageAttachments, setImageAttachments] = useState<string[]>([])
  const [showExpandModal, setShowExpandModal] = useState(false)
  const [monoFont, setMonoFont] = useState(false)
  const [largePasteFlash, setLargePasteFlash] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modalTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Sync initial values when they change (onboard flow)
  useEffect(() => {
    if (initialTitle) setTitle(initialTitle)
  }, [initialTitle])
  useEffect(() => {
    if (initialDescription) setDescription(initialDescription)
  }, [initialDescription])

  // Auto-grow is disabled — textarea uses flex-1 to fill available height.
  // The expand modal still uses its own full-height layout.

  // ── URL detection on description change ──
  const handleDescriptionChange = useCallback((value: string, prevLength?: number) => {
    setDescription(value)
    // Detect large paste
    if (prevLength !== undefined && value.length - prevLength > LARGE_PASTE_THRESHOLD) {
      setLargePasteFlash(true)
      setTimeout(() => setLargePasteFlash(false), 2500)
    }
    // Detect URLs in pasted text
    const detected = extractUrls(value)
    if (detected.length > 0) {
      setReferenceDocs((prev) => mergeUrlRefs(prev, detected))
    }
  }, [])

  // ── Char / word count ──
  const charCount = description.length
  const wordCount = description.trim() ? description.trim().split(/\s+/).length : 0
  const showMeta = charCount > CHAR_COUNT_THRESHOLD

  // ── File drop handler ──
  const imageCount = imageAttachments.length
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newFiles: ReferenceDocument[] = []
      const newImages: string[] = []
      let imgCount = imageCount

      for (const f of acceptedFiles) {
        const filePath = window.api.getPathForFile(f)
        if (!filePath) continue

        if (IMAGE_REGEX.test(filePath)) {
          if (imgCount >= MAX_IMAGE_ATTACHMENTS) continue
          newImages.push(filePath)
          imgCount++
        } else {
          const name = filePath.split('/').pop() || filePath.split('\\').pop() || filePath
          newFiles.push({ type: 'file', path: filePath, name })
        }
      }

      if (newFiles.length > 0) {
        setReferenceDocs((prev) => {
          const existingPaths = new Set(prev.map((d) => d.path))
          const unique = newFiles.filter((d) => !existingPaths.has(d.path))
          return [...prev, ...unique]
        })
      }
      if (newImages.length > 0) {
        setImageAttachments((prev) => [...prev, ...newImages])
      }
    },
    [imageCount]
  )

  // ── Clipboard paste (images; large-text paste is detected in onChange) ──
  const handleImageSaved = useCallback((filePath: string) => {
    setImageAttachments((prev) => [...prev, filePath])
  }, [])
  const handlePaste = useClipboardImagePaste({
    // Stable scope dir — saved filenames are already timestamped, so a
    // per-mount Date.now() suffix only fragmented the folder (and is impure
    // during render).
    conversationId: BLUEPRINT_IMAGE_SCOPE,
    imageCount,
    onImageSaved: handleImageSaved
  })

  // ── Dropzone setup ──
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    accept: ACCEPTED_EXTENSIONS.reduce(
      (acc, ext) => {
        acc[`application/${ext.slice(1)}`] = [ext]
        return acc
      },
      {} as Record<string, string[]>
    )
  })

  // ── Remove handlers ──
  const removeRefDoc = useCallback((index: number) => {
    setReferenceDocs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const removeImage = useCallback((index: number) => {
    setImageAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ── Submit ──
  const handleSubmit = useCallback(() => {
    if (!title.trim()) return

    const allDocs: ReferenceDocument[] = [...referenceDocs]
    for (const imgPath of imageAttachments) {
      allDocs.push({
        type: 'file',
        path: imgPath,
        name: imgPath.split('/').pop() || 'image'
      })
    }

    onStart({
      title: title.trim(),
      description: description.trim() || undefined,
      settingsJson: allDocs.length > 0 ? { referenceDocuments: allDocs } : undefined
    })
  }, [title, description, referenceDocs, imageAttachments, onStart])

  // ── Keyboard shortcut ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && title.trim()) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [title, handleSubmit]
  )

  const hasAttachments = referenceDocs.length > 0 || imageAttachments.length > 0

  return (
    <>
      <div
        {...getRootProps()}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        className={`bg-surface-raised rounded-xl border overflow-hidden transition-colors flex flex-col flex-1 min-h-0 ${
          isDragActive ? 'border-accent border-dashed bg-accent/5' : 'border-border-subtle'
        }`}
      >
        <input {...getInputProps()} />

        {/* Drag overlay */}
        {isDragActive && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-accent/10 border-2 border-dashed border-accent z-10">
            <div className="text-center">
              <Upload size={24} className="text-accent mx-auto mb-2" />
              <p className="text-sm text-accent font-medium">Drop files here</p>
              <p className="text-xs text-text-muted mt-0.5">Documents, images, code files</p>
            </div>
          </div>
        )}

        <div className="p-5 space-y-4 flex-1 min-h-0 flex flex-col">
          <h4 className="text-sm font-semibold text-text-primary">New Blueprint</h4>

          {/* ── Two-column grid ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* Left column: Title + Description (2/3) */}
            <div className="lg:col-span-2 space-y-3 flex flex-col">
              {/* Title */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Add user notification preferences page"
                  className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  autoFocus
                />
              </div>

              {/* Description — large-paste editor */}
              <div className="relative flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-text-secondary">Description</label>
                  <button
                    type="button"
                    onClick={() => setShowExpandModal(true)}
                    className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                    title="Expand to full-screen editor"
                  >
                    <Maximize2 size={10} />
                    Expand
                  </button>
                </div>
                <textarea
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => handleDescriptionChange(e.target.value, description.length)}
                  placeholder="Describe the feature in detail. Paste specs, requirements, or URLs — they'll be auto-detected.&#10;&#10;You can also drag & drop files or use the attachment panel."
                  className={`w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none leading-relaxed overflow-y-auto flex-1 min-h-[160px] ${monoFont ? 'font-mono text-xs' : ''}`}
                />

                {/* Large paste flash */}
                {largePasteFlash && (
                  <div className="absolute top-8 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-green-900/80 text-green-300 text-[10px] font-medium animate-pulse">
                    <Check size={10} />
                    Large paste captured ✓
                  </div>
                )}

                {/* Footer meta row */}
                {showMeta && (
                  <div className="flex items-center justify-between mt-1.5 px-0.5">
                    <span className="text-[10px] text-text-muted">
                      {charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} chars ·{' '}
                      {wordCount.toLocaleString()} words
                    </span>
                    <button
                      type="button"
                      onClick={() => setMonoFont(!monoFont)}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${monoFont ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text-secondary'}`}
                    >
                      {monoFont ? 'Sans' : 'Mono'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right column: Attachment Zone (1/3) */}
            <div className="lg:col-span-1 space-y-3 overflow-y-auto">
              {/* Drop zone card */}
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  open()
                }}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed border-border-subtle hover:border-accent/50 hover:bg-accent/5 cursor-pointer transition-colors min-h-[120px]"
              >
                <Upload size={20} className="text-text-muted" />
                <div className="text-center">
                  <p className="text-xs font-medium text-text-secondary">
                    Drop files or click to browse
                  </p>
                  <p className="text-[10px] text-text-muted mt-0.5">
                    or paste images from clipboard
                  </p>
                </div>
              </div>

              {/* Supported format chips */}
              <div className="flex flex-wrap gap-1">
                {SUPPORTED_FORMAT_CHIPS.map((chip) => (
                  <span
                    key={chip.label}
                    className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${chip.color} bg-transparent`}
                  >
                    {chip.label}
                  </span>
                ))}
              </div>

              {/* Image previews */}
              {imageAttachments.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                    Images ({imageCount}/{MAX_IMAGE_ATTACHMENTS})
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {imageAttachments.map((path, idx) => (
                      <ImagePreviewThumbnail
                        key={`${path}-${idx}`}
                        filePath={path}
                        onRemove={() => removeImage(idx)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Reference docs list */}
              {referenceDocs.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                    Attachments ({referenceDocs.length})
                  </span>
                  <ReferenceDocList documents={referenceDocs} onRemove={removeRefDoc} />
                </div>
              )}

              {/* Extra attach button when items exist */}
              {hasAttachments && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    open()
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base border border-border-subtle rounded-lg hover:bg-surface-hover transition-colors w-full justify-center"
                >
                  <Paperclip size={13} />
                  Add more files
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle bg-surface-overlay/30">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Back
            </button>
            {hasAttachments && (
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <Link2 size={10} />
                {referenceDocs.length + imageAttachments.length} attached
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-muted hidden sm:block">⌘+Enter to start</span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!title.trim()}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start Pipeline
            </button>
          </div>
        </div>
      </div>

      {/* ── Full-screen expand modal ── */}
      {showExpandModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[90vw] max-w-4xl h-[80vh] bg-surface-raised rounded-xl border border-border-subtle flex flex-col overflow-hidden shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">Description Editor</span>
                <button
                  type="button"
                  onClick={() => setMonoFont(!monoFont)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${monoFont ? 'bg-accent/20 border-accent/30 text-accent' : 'border-border-subtle text-text-muted hover:text-text-secondary'}`}
                >
                  {monoFont ? 'Monospace' : 'Sans-serif'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowExpandModal(false)}
                className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            {/* Modal textarea */}
            <div className="flex-1 p-4 overflow-hidden">
              <textarea
                ref={modalTextareaRef}
                value={description}
                onChange={(e) => handleDescriptionChange(e.target.value, description.length)}
                className={`w-full h-full bg-surface-base border border-border-subtle rounded-lg px-4 py-3 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none leading-relaxed ${monoFont ? 'font-mono text-xs' : ''}`}
                placeholder="Paste your full specification, requirements document, or feature description here..."
                autoFocus
              />
            </div>
            {/* Modal footer */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle">
              <span className="text-[10px] text-text-muted">
                {charCount >= 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} chars ·{' '}
                {wordCount.toLocaleString()} words
              </span>
              <button
                type="button"
                onClick={() => setShowExpandModal(false)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

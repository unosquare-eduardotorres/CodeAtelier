import { useCallback } from 'react'
import type React from 'react'

/** Maximum number of image attachments per message */
export const MAX_IMAGE_ATTACHMENTS = 5

/** Matches attachment paths that should render as image thumbnails */
export const IMAGE_REGEX = /\.(png|jpg|jpeg|gif|webp)$/i

/**
 * Body used when a conversation is created with attachments but no description
 * text. Guarantees a non-empty prompt reaches the executor and leaves a
 * readable user turn in the transcript.
 */
export const IMAGE_ONLY_FALLBACK_PROMPT = 'Please review the attached image(s).'

interface UseClipboardImagePasteOptions {
  /** Scope for the saved file — 'unsorted' before the conversation exists */
  conversationId: string
  /** How many images are already attached (gates MAX_IMAGE_ATTACHMENTS) */
  imageCount: number
  /**
   * Receives the absolute path of the saved image. Apply it with a functional
   * updater — this fires from an async FileReader callback, so any attachments
   * snapshot captured by the caller would be stale on rapid pastes.
   */
  onImageSaved: (filePath: string) => void
  /** Called instead of saving when the image limit is already reached */
  onLimitReached?: () => void
  /** Called when the save fails */
  onError?: (error: unknown) => void
}

/**
 * Shared clipboard-image paste handler.
 *
 * Bind the returned handler to `onPaste` on any element that should accept
 * pasted images (description textarea, dropzone root, ...). Non-image clipboard
 * content falls through to native paste behaviour untouched.
 */
export function useClipboardImagePaste({
  conversationId,
  imageCount,
  onImageSaved,
  onLimitReached,
  onError
}: UseClipboardImagePasteOptions): (e: React.ClipboardEvent) => void {
  return useCallback(
    (e: React.ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of Array.from(items)) {
        // Only images are intercepted — text/rich-text paste stays native
        if (!item.type.startsWith('image/')) continue

        e.preventDefault()

        if (imageCount >= MAX_IMAGE_ATTACHMENTS) {
          onLimitReached?.()
          return
        }

        const blob = item.getAsFile()
        if (!blob) continue

        const reader = new FileReader()
        reader.onload = async (): Promise<void> => {
          try {
            const dataUrl = reader.result as string
            const filePath = await window.api.saveClipboardImage({ dataUrl, conversationId })
            onImageSaved(filePath)
          } catch (error) {
            console.error('Failed to save clipboard image:', error)
            onError?.(error)
          }
        }
        reader.readAsDataURL(blob)
        return // Only the first image in the clipboard is handled
      }
    },
    [conversationId, imageCount, onImageSaved, onLimitReached, onError]
  )
}

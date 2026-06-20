/**
 * useBlueprintFormState — input form state (title, description, attachments) for blueprint creation.
 * Extracted from useBlueprintPageState to reduce cyclomatic complexity.
 */
import { useState, useEffect, useCallback } from 'react'
import { extractUrls, mergeUrlRefs } from '.'
import type { ReferenceDocument } from '../../../../../shared/blueprint-types'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useBlueprintFormState() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [referenceDocuments, setReferenceDocuments] = useState<ReferenceDocument[]>([])
  const [showFileTree, setShowFileTree] = useState(false)

  // Debounced URL detection from description text
  useEffect(() => {
    if (!description.trim()) return
    const timer = setTimeout(() => {
      const detectedUrls = extractUrls(description)
      if (detectedUrls.length > 0) {
        setReferenceDocuments((prev) => mergeUrlRefs(prev, detectedUrls))
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [description])

  const handleAttachments = useCallback((paths: string[]) => {
    setReferenceDocuments((prev) => {
      const nonFileRefs = prev.filter((d) => d.type !== 'file')
      const fileRefs: ReferenceDocument[] = paths.map((p) => ({
        type: 'file' as const,
        path: p,
        name: p.split(/[\\/]/).pop() || p
      }))
      return [...nonFileRefs, ...fileRefs]
    })
  }, [])

  const handleWorkspaceFiles = useCallback((files: ReferenceDocument[]) => {
    setReferenceDocuments((prev) => [...prev, ...files])
    setShowFileTree(false)
  }, [])

  const handleRemoveDoc = useCallback((index: number) => {
    setReferenceDocuments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const resetForm = (): void => {
    setTitle('')
    setDescription('')
    setReferenceDocuments([])
  }

  const prefillForm = (t: string, d: string, docs: ReferenceDocument[]): void => {
    setTitle(t)
    setDescription(d)
    setReferenceDocuments(docs)
  }

  return {
    title,
    setTitle,
    description,
    setDescription,
    referenceDocuments,
    showFileTree,
    setShowFileTree,
    handleAttachments,
    handleWorkspaceFiles,
    handleRemoveDoc,
    resetForm,
    prefillForm
  }
}

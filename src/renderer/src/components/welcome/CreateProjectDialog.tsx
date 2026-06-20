/**
 * CreateProjectDialog — single-screen modal for creating a blank project.
 *
 * Collects name, folder, brief description, and optional reference documents.
 * On submit: creates project shell → git init → sets blueprint onboard flag →
 * opens the workspace (which auto-navigates to Blueprints tab).
 */

import { useState, useCallback, useMemo } from 'react'
import { X, FolderOpen, Sparkles, Loader2 } from 'lucide-react'
import { AttachmentDropzone } from '@renderer/components/chat'
import { useBlueprintStore } from '@renderer/store/blueprint.store'

interface CreateProjectDialogProps {
  onClose: () => void
  onCreated: (workspaceId: string) => void
}

/** Characters not allowed in folder names */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

// ── useCreateProject hook ───────────────────────────────────────────

function useCreateProject(onCreated: (id: string) => void) {
  const [projectName, setProjectName] = useState('')
  const [parentFolder, setParentFolder] = useState('')
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)

  const nameError = useMemo((): string | null => {
    if (!projectName) return null
    if (projectName.length > 255) return 'Name must be 255 characters or fewer'
    if (UNSAFE_CHARS.test(projectName))
      return 'Name contains characters not allowed in folder names'
    return null
  }, [projectName])

  const isValid =
    projectName.trim().length > 0 && !nameError && parentFolder.trim().length > 0 && !isCreating

  const resolvedPath =
    parentFolder && projectName.trim() ? `${parentFolder}/${projectName.trim()}` : null

  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await window.api.selectDirectory()
      if (selected) {
        setParentFolder(selected)
        setFolderError(null)
      }
    } catch {
      setFolderError('Failed to select directory')
    }
  }, [])

  const handleCreate = useCallback(async () => {
    if (!isValid) return
    setIsCreating(true)
    setError(null)

    let workspace: { id: string } | undefined
    try {
      workspace = await window.api.createProjectShell({
        name: projectName.trim(),
        parentFolder,
        description: description.trim() || undefined,
        attachments: attachments.length > 0 ? attachments : undefined
      })

      await window.api.initRepo({ workspaceId: workspace.id })

      const referenceDocuments = attachments.map((a) => {
        const name = a.split(/[\\/]/).pop() || a
        return { type: 'file' as const, path: `.context/${name}`, name }
      })

      if (referenceDocuments.length > 0) {
        await window.api.workspaceAddReferenceDocs({
          workspaceId: workspace.id,
          documents: referenceDocuments
        })
      }

      useBlueprintStore.getState().setPendingOnboard({
        title: projectName.trim(),
        description: description.trim(),
        referenceDocuments
      })

      onCreated(workspace.id)
    } catch (err) {
      if (workspace?.id) {
        try {
          await window.api.discardProjectShell({ workspaceId: workspace.id })
        } catch {
          // Best-effort cleanup
        }
      }
      setError(err instanceof Error ? err.message : 'Failed to create project')
      setIsCreating(false)
    }
  }, [isValid, projectName, parentFolder, description, attachments, onCreated])

  return {
    projectName, setProjectName, parentFolder, description, setDescription,
    attachments, setAttachments, isCreating, error, folderError, nameError,
    isValid, resolvedPath, handleCreate, handleSelectFolder
  }
}

// ── Main component ───────────────────────────────────────────────────

export default function CreateProjectDialog({
  onClose,
  onCreated
}: CreateProjectDialogProps): React.JSX.Element {
  const {
    projectName, setProjectName, parentFolder, description, setDescription,
    attachments, setAttachments, isCreating, error, folderError, nameError,
    isValid, resolvedPath, handleCreate, handleSelectFolder
  } = useCreateProject(onCreated)

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isCreating) onClose()
      }}
    >
      <div className="w-full max-w-lg bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden" data-testid="create-project-dialog">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary-muted border border-primary/30">
              <Sparkles size={16} className="text-primary-text" />
            </div>
            <h2 className="text-sm font-semibold text-text-primary">Create New Project</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted
                       hover:text-text-primary hover:bg-surface-overlay transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Error banner */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/30">
              <p className="text-xs text-danger">❌ {error}</p>
            </div>
          )}

          {/* Project Name */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cpd-name" className="text-xs font-medium text-text-secondary">
              Project Name
            </label>
            <input
              id="cpd-name"
              data-testid="create-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="my-awesome-app"
              className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle
                         text-sm text-text-primary placeholder:text-text-muted
                         focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40
                         transition-colors"
              autoFocus
              disabled={isCreating}
            />
            {nameError && <p className="text-xs text-danger">{nameError}</p>}
          </div>

          {/* Location */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Location</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectFolder}
                disabled={isCreating}
                data-testid="create-project-folder-btn"
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle
                           text-xs text-text-secondary hover:text-text-primary hover:border-primary/40
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FolderOpen size={14} />
                Choose Folder
              </button>
              {parentFolder && (
                <span className="text-xs text-text-muted truncate flex-1" title={parentFolder}>
                  {parentFolder}
                </span>
              )}
            </div>
            {folderError && <p className="text-xs text-danger">{folderError}</p>}
            {resolvedPath && (
              <p className="text-xs text-text-muted">
                Will create:{' '}
                <code className="px-1 py-0.5 rounded bg-surface-base text-text-secondary font-mono text-[10px]">
                  {resolvedPath}
                </code>
              </p>
            )}
          </div>

          {/* Description + Attachments */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cpd-desc" className="text-xs font-medium text-text-secondary">
              What are you building? <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <AttachmentDropzone
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              conversationId="create-project-dialog"
            >
              <textarea
                id="cpd-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="A brief description — one or two sentences is plenty. You can elaborate when the Blueprint pipeline starts."
                className="flex-1 w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted
                           resize-none focus:outline-none leading-relaxed"
                disabled={isCreating}
              />
            </AttachmentDropzone>
            <p className="text-xs text-text-muted">
              Drop reference docs, mockups, or specs to include as context
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle bg-surface-overlay/30">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!isValid}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       bg-primary hover:bg-primary-hover text-white
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {isCreating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Create Project
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

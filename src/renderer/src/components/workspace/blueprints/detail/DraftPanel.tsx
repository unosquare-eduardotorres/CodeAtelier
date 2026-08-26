/**
 * DraftPanel — everything a draft blueprint can do before it runs.
 *
 * A draft is a blueprint that exists but has never started: the Jira ticket
 * importer creates them, and until now opening one was a dead end — no way to
 * edit the brief, no way to see or add attachments, no way to start it.
 *
 * Two states:
 *   - idle: banner explaining the draft + Edit / Start buttons, plus the
 *     read-only attachment list
 *   - editing: title, description and attachments, saved through
 *     `blueprint:update` (which refuses anything that is no longer a draft)
 */

import { useState, useCallback, useEffect, type JSX } from 'react'
import { useDropzone } from 'react-dropzone'
import { FileEdit, PlayCircle, Paperclip, Save, X, Upload, GitBranch } from 'lucide-react'
import type {
  BlueprintWithDetails,
  BlueprintBranchChoice,
  ReferenceDocument
} from '../../../../../../shared/blueprint-types'
import {
  buildBlueprintBranchName,
  readJiraIssueKey
} from '../../../../../../shared/blueprint-branch-name'
import { useBlueprintStore } from '@renderer/store/blueprint.store'
import { rendererLog } from '@renderer/utils/logger'
import { useClipboardImagePaste, IMAGE_REGEX } from '@renderer/hooks'
import { DROPZONE_ACCEPT } from '../attachment-formats'
import { newDraftScope, stageDroppedImages, clearDraftScope } from '../image-staging'
import ReferenceDocList from '../ReferenceDocList'
import ImagePreviewThumbnail from '../../../chat/ImagePreviewThumbnail'
import { BlueprintAttachments } from './BlueprintAttachments'
import { BlueprintBranchPicker } from '../BlueprintBranchPicker'
import { extractReferenceDocs, partitionImages, readBranchChoice } from './reference-docs'

/**
 * What the draft says about where it will run.
 *
 * Nothing is reserved until Start, so this is a prediction, not a fact — the
 * wording says so. Null means "the workspace checkout", which has no branch of
 * its own to name.
 */
function describeBranch(
  blueprint: BlueprintWithDetails,
  choice: BlueprintBranchChoice,
  title: string
): string | null {
  if (choice.mode === 'primary') return null
  // Takeover with nothing picked yet falls back to a new branch, exactly as the
  // main-process reservation does.
  if (choice.mode === 'takeover' && choice.branch) return choice.branch
  if (choice.mode === 'fork' && choice.name) return choice.name
  return buildBlueprintBranchName({
    title,
    jiraIssueKey: readJiraIssueKey(blueprint.settingsJson),
    blueprintId: blueprint.id
  })
}

interface DraftPanelProps {
  blueprint: BlueprintWithDetails
  workspaceId: string | null
}

export function DraftPanel({ blueprint, workspaceId }: DraftPanelProps): JSX.Element {
  const startExistingBlueprint = useBlueprintStore((s) => s.startExistingBlueprint)
  const updateDraft = useBlueprintStore((s) => s.updateDraft)

  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Per-mount staging dir for pasted and dropped images so they preview before
  // the save round-trip. blueprint:update runs copy-on-attach, so anything
  // saved already lives in the managed docs dir by the time this is cleared.
  const [draftScope] = useState(newDraftScope)
  useEffect(() => () => clearDraftScope(draftScope), [draftScope])

  const savedDocs = extractReferenceDocs(blueprint.settingsJson)

  // Draft form state — seeded on entry to edit mode so Cancel is a true revert.
  const [title, setTitle] = useState(blueprint.title)
  const [description, setDescription] = useState(blueprint.description ?? '')
  const [docs, setDocs] = useState<ReferenceDocument[]>(savedDocs)
  const [branchChoice, setBranchChoice] = useState<BlueprintBranchChoice>(() =>
    readBranchChoice(blueprint.settingsJson)
  )

  const savedBranch = describeBranch(
    blueprint,
    readBranchChoice(blueprint.settingsJson),
    blueprint.title
  )

  const beginEdit = useCallback(() => {
    setTitle(blueprint.title)
    setDescription(blueprint.description ?? '')
    setDocs(extractReferenceDocs(blueprint.settingsJson))
    setBranchChoice(readBranchChoice(blueprint.settingsJson))
    setError(null)
    setEditing(true)
  }, [blueprint])

  // ── Attachment handling ──

  const addPaths = useCallback((paths: string[]) => {
    setDocs((prev) => {
      const seen = new Set(prev.map((d) => d.path))
      const added = paths
        .filter((p) => !seen.has(p))
        .map<ReferenceDocument>((p) => ({
          type: 'file',
          path: p,
          name: p.split(/[/\\]/).pop() || p
        }))
      return added.length > 0 ? [...prev, ...added] : prev
    })
  }, [])

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const paths = accepted.map((f) => window.api.getPathForFile(f)).filter(Boolean) as string[]
      if (paths.length === 0) return
      // Only images are staged — other drops keep their original path and are
      // copied by copy-on-attach on save, as they always have been.
      const images = paths.filter((p) => IMAGE_REGEX.test(p))
      const others = paths.filter((p) => !IMAGE_REGEX.test(p))
      const staged = images.length > 0 ? await stageDroppedImages(draftScope, images) : []
      addPaths([...others, ...staged])
    },
    [addPaths, draftScope]
  )

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    accept: DROPZONE_ACCEPT
  })

  const handleImageSaved = useCallback((filePath: string) => addPaths([filePath]), [addPaths])
  const handlePaste = useClipboardImagePaste({
    conversationId: draftScope,
    // Blueprint attachments are read from disk by the agent's file tools, not
    // packed into a vision payload, so the chat image cap does not apply here.
    imageCount: 0,
    onImageSaved: handleImageSaved
  })

  const removeDoc = useCallback((index: number) => {
    setDocs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ── Actions ──

  const handleSave = useCallback(async () => {
    if (!title.trim()) {
      setError('Title cannot be empty.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateDraft({
        blueprintId: blueprint.id,
        title: title.trim(),
        description: description.trim(),
        referenceDocuments: docs,
        branchChoice
      })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [blueprint.id, title, description, docs, branchChoice, updateDraft])

  const handleStart = useCallback(async () => {
    if (!workspaceId) {
      setError('No workspace selected.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await startExistingBlueprint(blueprint.id, workspaceId)
    } catch (err) {
      rendererLog.error('[draft-panel] Start failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
    // On success the store flips isRunning and the page swaps to the active
    // view, unmounting this panel — leaving `busy` set keeps the button from
    // firing twice during that transition.
  }, [blueprint.id, workspaceId, startExistingBlueprint])

  // ── Editing ──

  if (editing) {
    const { images, rest } = partitionImages(docs)
    // Recomputed from the *edited* title, so renaming the draft updates the
    // name shown under the picker.
    const editedBranch = describeBranch(blueprint, branchChoice, title)
    return (
      <div
        data-testid="draft-editor"
        {...getRootProps()}
        onPaste={handlePaste}
        className={`bg-surface-raised rounded-xl border p-4 space-y-4 transition-colors ${
          isDragActive ? 'border-accent bg-accent/5' : 'border-border-subtle'
        }`}
      >
        <input {...getInputProps()} />

        <div className="flex items-center gap-2">
          <FileEdit size={13} className="text-accent" />
          <span className="text-xs font-semibold text-text-primary">Edit draft</span>
          {isDragActive && (
            <span className="text-[10px] text-accent flex items-center gap-1">
              <Upload size={10} /> Drop to attach
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="draft-title"
            className="text-[10px] font-medium text-text-muted uppercase tracking-wide"
          >
            Title
          </label>
          <input
            id="draft-title"
            data-testid="draft-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-surface-base border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="draft-description"
            className="text-[10px] font-medium text-text-muted uppercase tracking-wide"
          >
            Description
          </label>
          <textarea
            id="draft-description"
            data-testid="draft-description-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={12}
            className="w-full px-3 py-2 text-sm bg-surface-base border border-border-subtle rounded-lg text-text-primary font-mono resize-y focus:outline-none focus:border-accent transition-colors"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
              Attachments ({docs.length})
            </span>
            <button
              type="button"
              onClick={open}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base border border-border-subtle rounded-lg hover:bg-surface-hover transition-colors"
            >
              <Paperclip size={12} />
              Add files
            </button>
          </div>

          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {images.map((doc) => (
                <ImagePreviewThumbnail
                  key={doc.path}
                  filePath={doc.path}
                  onRemove={() => removeDoc(docs.indexOf(doc))}
                />
              ))}
            </div>
          )}

          {rest.length > 0 && (
            <ReferenceDocList documents={rest} onRemove={(i) => removeDoc(docs.indexOf(rest[i]))} />
          )}

          {docs.length === 0 && (
            <p className="text-[11px] text-text-muted">
              Drop files here, paste a screenshot, or use Add files.
            </p>
          )}
        </div>

        {/* Branch — picked here rather than at Start, because a draft (a Jira
            import especially) is created long before anyone presses Start. */}
        {workspaceId && (
          <div onClick={(e) => e.stopPropagation()} role="presentation">
            <BlueprintBranchPicker
              workspaceId={workspaceId}
              value={branchChoice}
              onChange={setBranchChoice}
            />
            {editedBranch && (
              <p className="text-[10px] text-text-muted mt-1.5 font-mono truncate">
                {editedBranch}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="draft-save-btn"
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/80 disabled:opacity-50 rounded-lg transition-colors"
          >
            <Save size={12} />
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setError(null)
            }}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base border border-border-subtle rounded-lg hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // ── Idle ──

  return (
    <div className="space-y-4">
      <div
        data-testid="draft-banner"
        className="flex items-start gap-3 px-4 py-3 rounded-xl border border-accent/20 bg-accent/5 text-accent"
      >
        <FileEdit size={16} className="mt-0.5 flex-shrink-0" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-sm font-medium">Draft — not started</span>
          <span className="text-xs opacity-80">
            Review the brief and attach anything the agent will need, then start the pipeline.
          </span>
          {/* Named, not created: the branch is reserved when the run starts. */}
          <span
            data-testid="draft-branch-preview"
            className="text-[11px] opacity-70 flex items-center gap-1 mt-0.5 min-w-0"
          >
            <GitBranch size={11} className="flex-shrink-0" />
            {savedBranch ? (
              <>
                Will run on <span className="font-mono truncate">{savedBranch}</span>
              </>
            ) : (
              <>Will run in your workspace checkout</>
            )}
          </span>
          {error && <span className="text-xs text-danger mt-1">{error}</span>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            data-testid="draft-edit-btn"
            onClick={beginEdit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base border border-border-subtle rounded-lg hover:bg-surface-hover disabled:opacity-50 transition-colors"
          >
            <FileEdit size={12} />
            Edit
          </button>
          <button
            type="button"
            data-testid="draft-start-btn"
            onClick={handleStart}
            disabled={busy || !workspaceId}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/80 disabled:opacity-50 rounded-lg transition-colors"
          >
            <PlayCircle size={12} />
            {busy ? 'Starting…' : 'Start Blueprint'}
          </button>
        </div>
      </div>

      <BlueprintAttachments documents={savedDocs} />
    </div>
  )
}

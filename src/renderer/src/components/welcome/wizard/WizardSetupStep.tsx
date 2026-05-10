/**
 * WizardSetupStep — Step 1 of the Create New Project wizard.
 *
 * Collects project name, location (parent folder), and a description
 * of what the user wants to build. The description textarea includes
 * a detailed placeholder to guide first-time users.
 */

import { useState, useCallback, useMemo } from 'react'
import { FolderOpen, ArrowRight, SkipForward } from 'lucide-react'

interface WizardSetupStepProps {
  projectName: string
  parentFolder: string
  description: string
  onProjectNameChange: (name: string) => void
  onParentFolderChange: (folder: string) => void
  onDescriptionChange: (desc: string) => void
  onNext: () => void
  onSkipGrill: () => void
}

/** Characters not allowed in folder names */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

export default function WizardSetupStep({
  projectName,
  parentFolder,
  description,
  onProjectNameChange,
  onParentFolderChange,
  onDescriptionChange,
  onNext,
  onSkipGrill
}: WizardSetupStepProps): React.JSX.Element {
  const [folderError, setFolderError] = useState<string | null>(null)

  // Derive name validation from props (no setState in effect)
  const nameError = useMemo((): string | null => {
    if (!projectName) return null
    if (projectName.length > 255) return 'Name must be 255 characters or fewer'
    if (UNSAFE_CHARS.test(projectName))
      return 'Name contains characters not allowed in folder names'
    return null
  }, [projectName])

  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await window.api.selectDirectory()
      if (selected) {
        onParentFolderChange(selected)
        setFolderError(null)
      }
    } catch {
      setFolderError('Failed to select directory')
    }
  }, [onParentFolderChange])

  const isValid = projectName.trim().length > 0 && !nameError && parentFolder.trim().length > 0

  const resolvedPath =
    parentFolder && projectName.trim() ? `${parentFolder}/${projectName.trim()}` : null

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="text-center mb-2">
        <h2 className="text-xl font-semibold text-text-primary">Set Up Your Project</h2>
        <p className="text-sm text-text-secondary mt-1">
          Tell us about your project so we can help you plan it
        </p>
      </div>

      {/* Project Name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-name" className="text-sm font-medium text-text-primary">
          Project Name
        </label>
        <input
          id="project-name"
          type="text"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
          placeholder="my-awesome-app"
          className="w-full px-3 py-2.5 rounded-lg bg-surface-overlay border border-border-subtle
                     text-sm text-text-primary placeholder:text-text-muted
                     focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40
                     transition-colors"
          autoFocus
        />
        {nameError && <p className="text-xs text-danger mt-0.5">{nameError}</p>}
      </div>

      {/* Location */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-primary">Location</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSelectFolder}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-surface-overlay border border-border-subtle
                       text-sm text-text-secondary hover:text-text-primary hover:border-primary/40
                       transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <FolderOpen size={16} />
            Choose Location
          </button>
          {parentFolder && (
            <span className="text-xs text-text-muted truncate flex-1" title={parentFolder}>
              {parentFolder}
            </span>
          )}
        </div>
        {folderError && <p className="text-xs text-danger mt-0.5">{folderError}</p>}
        {resolvedPath && (
          <p className="text-xs text-text-muted mt-1">
            Project will be created at:{' '}
            <code className="px-1 py-0.5 rounded bg-surface-base text-text-secondary font-mono text-[11px]">
              {resolvedPath}
            </code>
          </p>
        )}
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-description" className="text-sm font-medium text-text-primary">
          Description
        </label>
        <textarea
          id="project-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={5}
          placeholder={`Describe what you want to build. For example:\n\n"I want to build a macOS menu bar app that tracks my daily water intake, reminds me to drink, and shows weekly stats. It should sync across my Apple devices via iCloud."`}
          className="w-full px-3 py-2.5 rounded-lg bg-surface-overlay border border-border-subtle
                     text-sm text-text-primary placeholder:text-text-muted resize-y min-h-[120px]
                     focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40
                     transition-colors leading-relaxed"
        />
        <div className="flex justify-between">
          <p className="text-xs text-text-muted">
            The more detail you provide, the better the AI can help you plan
          </p>
          {description.length > 0 && (
            <span className="text-xs text-text-muted">{description.length} chars</span>
          )}
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-border-subtle">
        <button
          type="button"
          onClick={onSkipGrill}
          disabled={!isValid}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                     text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <SkipForward size={14} />
          Skip Grilling
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!isValid}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                     bg-primary hover:bg-primary-hover text-white
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
        >
          Next: Grill Session
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  )
}

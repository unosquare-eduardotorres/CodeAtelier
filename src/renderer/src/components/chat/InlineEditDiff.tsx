import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { compactDiffStyles, nightOwlHighlightTheme } from './diff-theme'
import { languageForPath } from '@renderer/utils/prism-languages'
import type { ToolEditDiff } from '../../../../shared/types'

interface InlineEditDiffProps {
  edits: ToolEditDiff[]
  /** Edits dropped by the storage budget in the main process. */
  omitted?: number
  /** File the edits apply to — drives syntax highlighting + language label. */
  filePath?: string
}

/**
 * Before/after view for Edit / MultiEdit tool calls, rendered inside the tool
 * activity expand panel. Unified (not split) because the panel is narrow, and
 * full-context because the segments are already just the changed region.
 */
export default function InlineEditDiff({
  edits,
  omitted = 0,
  filePath
}: InlineEditDiffProps): React.JSX.Element {
  const language = filePath ? languageForPath(filePath) : ''
  const label = edits.length > 1 ? `${edits.length} Edits` : 'Edit'

  return (
    <div data-testid="inline-edit-diff" className="px-3 py-2 border-b border-border-subtle/50">
      <span className="block text-[10px] uppercase tracking-wider text-text-secondary font-medium">
        {language ? `${label} · ${language}` : label}
      </span>
      {edits.map((edit, i) => (
        <div key={i} className="mt-1.5">
          {edits.length > 1 && (
            <span className="block text-[10px] text-text-muted mb-0.5">
              Edit {i + 1} of {edits.length}
              {edit.truncated && ' — truncated'}
            </span>
          )}
          <div className="rounded overflow-hidden border border-border-subtle/50">
            <ReactDiffViewer
              oldValue={edit.oldString}
              newValue={edit.newString}
              splitView={false}
              useDarkTheme={true}
              compareMethod={DiffMethod.WORDS}
              showDiffOnly={false}
              styles={compactDiffStyles}
              {...(language ? { highlightLanguage: language } : {})}
              highlightTheme={nightOwlHighlightTheme}
            />
          </div>
          {edits.length === 1 && edit.truncated && (
            <span className="block text-[10px] text-text-muted mt-0.5">
              Content truncated for storage.
            </span>
          )}
        </div>
      ))}
      {omitted > 0 && (
        <span className="block text-[10px] text-text-muted mt-1.5 italic">
          {omitted} more {omitted === 1 ? 'edit' : 'edits'} not shown.
        </span>
      )}
    </div>
  )
}

import type { FileDiffResult } from '../../../../shared/types'

/** Which body FileDiffView renders for a loaded diff. */
export type DiffState = 'binary' | 'identical' | 'diff'

/**
 * ReactDiffViewer renders nothing when both sides match, which is
 * indistinguishable from a broken pane — so the empty states are explicit.
 * Extracted as a pure function so the branching is unit-testable.
 */
export function resolveDiffState(diff: FileDiffResult): DiffState {
  if (diff.isBinary) return 'binary'
  if (diff.oldContent === diff.newContent) return 'identical'
  return 'diff'
}

/** Human-readable explanation for an identical pane, or null when git gave none. */
export function describeIdenticalReason(
  diff: FileDiffResult
): { title: string; detail: string } | null {
  switch (diff.identicalReason) {
    case 'mode-change': {
      const modes = diff.modeChange ? ` (${diff.modeChange.from} → ${diff.modeChange.to})` : ''
      return {
        title: `Only the file mode changed${modes}`,
        detail: 'Contents are identical — only the file permission changes.'
      }
    }
    case 'rename-only':
      return {
        title: 'File was moved',
        detail: 'Contents are identical — only the path changed.'
      }
    case 'empty-file':
      return {
        title: 'The file is empty',
        detail: 'It was added or removed with no content — there is nothing to compare.'
      }
    case 'eol-only': {
      const eols = diff.eolChange
        ? ` (${diff.eolChange.from.toUpperCase()} → ${diff.eolChange.to.toUpperCase()})`
        : ''
      return {
        title: `Only the line endings changed${eols}`,
        detail:
          'Every line is otherwise identical — the file was rewritten with a different newline convention.'
      }
    }
    case 'no-diff-entry':
      return {
        title: 'This file no longer differs from the comparison base',
        detail: 'Refresh the list to bring it up to date.'
      }
    case 'unexplained':
      return {
        title: 'No differences between the two sides',
        detail:
          'Git reports this file as changed but both sides resolved to identical content — that is a bug, not a clean file.'
      }
    default:
      return null
  }
}

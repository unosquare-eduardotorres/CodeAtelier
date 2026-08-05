/** Which body FileChangeList renders for the left pane. */
export type FileListState = 'git-missing' | 'loading' | 'list-failed' | 'empty' | 'list'

/**
 * Resolve the left pane's state.
 *
 * Extracted as a pure function because the branching answers "what will ship?",
 * and getting it wrong is silent: rendering the green "no changes" state after a
 * failed listing claims nothing will ship when we don't know what would, and
 * rendering "could not list changes" for an error that came from *push* or
 * *fetch* cries wolf about a listing that actually succeeded. Only the listing
 * error may reach here.
 */
export function resolveFileListState(o: {
  isGitConfigured: boolean
  isLoading: boolean
  fileCount: number
  error: string | null
}): FileListState {
  // No repo at all outranks everything — nothing else is meaningful without one.
  if (!o.isGitConfigured) return 'git-missing'
  if (o.fileCount > 0) return 'list'
  if (o.isLoading) return 'loading'
  if (o.error) return 'list-failed'
  return 'empty'
}

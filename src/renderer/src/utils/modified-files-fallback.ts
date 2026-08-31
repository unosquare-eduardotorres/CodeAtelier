/**
 * VERIFY modified-files fallback — aggregates the "what changed" list from
 * streamed tool activity when no git baseline exists (source === 'none').
 *
 * Mirrors the git path's shape (path / status / +/- counts, sorted by churn
 * descending) so ModifiedFilesSection can render both through one list UI.
 * Line counting reuses countDiffLines — the same contract the diff badges use.
 */
import type { ToolActivity } from '../../../shared/types'
import { countDiffLines } from '../components/chat/tool-activity-utils'

export interface ModifiedFileEntry {
  path: string
  status: 'M' | 'A' | 'D'
  additions: number
  deletions: number
}

/**
 * Build a modified-files list from tool activities:
 * - only completed edit/write activities with a filePath count
 * - dedupe by path — the last activity for a path wins
 * - counts come from editDiffs (countDiffLines contract)
 * - status is 'A' when every diff has an empty oldString (pure addition),
 *   else 'M' (the fallback never observes deletions, so 'D' is unreachable)
 * - sorted by churn (additions + deletions) descending, like the git path
 */
export function aggregateModifiedFilesFromActivities(
  activities: ToolActivity[]
): ModifiedFileEntry[] {
  const byPath = new Map<string, ToolActivity>()
  for (const activity of activities) {
    if (activity.operationType !== 'edit' && activity.operationType !== 'write') continue
    if (activity.status !== 'completed') continue
    if (!activity.filePath) continue
    byPath.set(activity.filePath, activity)
  }

  const entries: ModifiedFileEntry[] = []
  for (const [path, activity] of byPath) {
    const diffs = activity.editDiffs ?? []
    const { additions, deletions } = countDiffLines(diffs)
    entries.push({
      path,
      status: diffs.every((d) => d.oldString === '') ? 'A' : 'M',
      additions,
      deletions
    })
  }

  entries.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  return entries
}

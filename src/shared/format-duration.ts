/**
 * Elapsed-time formatting shared by the main process (notification summaries,
 * resume prompts) and the renderer (background-task uptimes).
 *
 * Kept in `shared/` so the two never drift — a build reported as "12m 3s" in a
 * toast must read the same in the popover.
 */

/** Human-readable elapsed time, e.g. "45s", "12m 3s", "2h 2m". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

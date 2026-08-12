/**
 * Windows hides child consoles via CREATE_NO_WINDOW, but that flag is ignored
 * when DETACHED_PROCESS is set (nodejs/node#21825). Detaching is only needed
 * for POSIX process-group kills anyway — on Windows we kill trees with
 * `taskkill /T`, which does not require a separate process group.
 */
const IS_WINDOWS = process.platform === 'win32'

/** For long-lived children that must outlive the parent. */
export const detachedHiddenSpawnOptions = {
  detached: !IS_WINDOWS,
  windowsHide: true
} as const

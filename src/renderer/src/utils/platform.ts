/**
 * Platform detection utility — centralizes navigator.platform checks.
 *
 * All 6+ call sites previously duplicated `navigator.platform.toUpperCase().includes('MAC')`.
 * This utility provides a single cached check and derived shortcut key labels.
 */

/** Whether the renderer is running on macOS. Cached at module load. */
export const isMacPlatform: boolean = navigator.platform.toUpperCase().includes('MAC')

/** The platform-appropriate modifier key symbol: ⌘ on Mac, Ctrl+ elsewhere. */
export const modifierKey: string = isMacPlatform ? '⌘' : 'Ctrl+'

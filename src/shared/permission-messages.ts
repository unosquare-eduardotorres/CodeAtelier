/**
 * User-facing copy for permission requests that ended without an approval.
 *
 * Shared so the persisted transcript message (main process) and the message the
 * renderer shows immediately are byte-identical — otherwise a reload silently
 * changes the wording of history.
 */

/** An auto-deny backstop expired before the user answered. */
export const PERMISSION_TIMEOUT_MESSAGE =
  'Permission was not approved and timed out — the request was denied.'

/** The turn ended (stopped, failed, or the CLI died) before the user answered. */
export const PERMISSION_CANCELLED_MESSAGE =
  'The permission request ended before it was answered — the tool was not run.'

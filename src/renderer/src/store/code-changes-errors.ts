/**
 * Turn a raw loadFiles rejection into what the panel should say.
 *
 * Extracted because the mapping used to live inline and got the shape of the
 * input wrong: Electron wraps every handler rejection as
 * `Error invoking remote method '<channel>': Error: REF_NOT_FOUND: …`, so a
 * `startsWith('REF_NOT_FOUND:')` check never matched in the running app and the
 * user saw the raw wrapped string instead of the explanation.
 */

/** Prefix Electron IPC adds to remote-method errors. */
const IPC_ERROR_PREFIX_RE = /^Error invoking remote method '[^']+': /

/** Strip the IPC wrapper and the `Error: ` the serializer leaves behind. */
export function unwrapIpcError(raw: string): string {
  return raw.replace(IPC_ERROR_PREFIX_RE, '').replace(/^Error:\s*/, '')
}

export interface LoadFilesErrorDescription {
  error: string
  /** A listing we can't trust must not keep rendering stale rows. */
  clearFiles: boolean
}

export function describeLoadFilesError(raw: string): LoadFilesErrorDescription {
  const msg = unwrapIpcError(raw)

  if (msg.startsWith('REF_NOT_FOUND:')) {
    const detail = msg.slice('REF_NOT_FOUND:'.length).trim()
    return {
      error: `Branch not found — if it is a remote branch, has it been pushed? (${detail})`,
      clearFiles: false
    }
  }

  if (msg.startsWith('DIFF_LIST_FAILED:')) {
    const detail = msg.slice('DIFF_LIST_FAILED:'.length).trim()
    return {
      error: `Could not list changes — the comparison is incomplete, do not trust this list. (${detail})`,
      clearFiles: true
    }
  }

  return { error: msg, clearFiles: false }
}

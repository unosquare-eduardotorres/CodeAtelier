/**
 * Pure rules for turning Jira attachment records into files on disk.
 *
 * Deliberately free of Electron and filesystem imports so the decisions that
 * carry risk — which files are fetched, and what they are allowed to be named —
 * are unit-testable. The download itself lives in `jira.ipc.ts`, which owns the
 * managed docs directory.
 */

import { basename, extname } from 'node:path'
import type { JiraAttachment } from '../../shared/jira.types'

/**
 * Attachment kinds worth downloading. Screenshots are the common case and the
 * reason this exists; the rest are formats the blueprint document loader can
 * actually read. Video, archives and binary dumps are skipped — they cost disk
 * and give the agent nothing.
 */
export const ATTACHMENT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.log',
  '.yml',
  '.yaml',
  '.html',
  '.xml',
  '.doc',
  '.docx'
])

/** Per-issue and per-file download ceilings. */
export const MAX_ATTACHMENTS_PER_ISSUE = 10
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * Whole-group ceiling, since one blueprint can now be built from many tickets.
 * Without it, twenty-five tickets at ten attachments each is 250 downloads and
 * up to 2.5 GB of managed docs for a single conversion.
 */
export const MAX_ATTACHMENTS_PER_GROUP = 30

/** Longest filename we will write, before the index prefix. */
const MAX_FILENAME_CHARS = 120

/**
 * Make a Jira-supplied filename safe to join onto a directory path.
 *
 * The name comes from whoever uploaded the file, so it is treated as hostile:
 * `basename` drops any directory part and the character filter removes
 * traversal sequences and shell-significant characters outright.
 */
export function safeAttachmentFilename(name: string): string {
  // basename() only understands the host separator, so both are normalised
  // first — a Windows-style name must not survive intact on macOS.
  const flattened = basename(name.replace(/\\/g, '/'))
  const stripped = flattened.replace(/[^A-Za-z0-9._-]/g, '_')
  // Keep the tail: the extension is what the loader and the UI dispatch on.
  const clipped = stripped.slice(-MAX_FILENAME_CHARS)
  if (!clipped || /^\.+$/.test(clipped)) return 'attachment'
  return clipped
}

/**
 * Name an attachment will be written under inside the managed docs directory.
 *
 * Both prefixes earn their place: the index disambiguates two files with the
 * same name on one ticket, and the issue key disambiguates them across tickets
 * — one blueprint can be built from a whole selection, and two tickets each
 * attaching `screenshot.png` is the common case, not an edge one.
 */
export function attachmentDestFilename(issueKey: string, index: number, filename: string): string {
  return `${safeAttachmentFilename(issueKey)}-${index}-${safeAttachmentFilename(filename)}`
}

/** Which attachments are worth fetching, in Jira's order, within the caps. */
export function selectAttachments(attachments: JiraAttachment[]): JiraAttachment[] {
  if (!Array.isArray(attachments)) return []
  return (
    attachments
      .filter((a) => a && typeof a.filename === 'string' && typeof a.contentUrl === 'string')
      .filter((a) => ATTACHMENT_EXTENSIONS.has(extname(a.filename).toLowerCase()))
      // Jira's reported size is advisory, but when it is present and already over
      // the cap there is no point spending a round trip to confirm it.
      .filter((a) => a.size === undefined || a.size <= MAX_ATTACHMENT_BYTES)
      .slice(0, MAX_ATTACHMENTS_PER_ISSUE)
  )
}

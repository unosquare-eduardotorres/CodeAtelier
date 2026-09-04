/**
 * FileListSection — shared labelled file list (BUILD "Files Created/Modified"
 * and future surfaces). Rows open the shared file-viewer via the global store,
 * so the surface only supplies the label, the files, and the viewer context.
 *
 * Design notes:
 *  - `selected` intentionally follows the global viewer `activeFile` — the
 *    cross-surface highlight is by design: when another surface (chat tool
 *    row, Files tab) opens a different file, rows here de-highlight to match.
 *  - Entries are deduped by path before rendering (last entry wins, order of
 *    first appearance preserved) — BUILD artifacts concatenate per-task
 *    completions without upstream dedupe, which would otherwise produce
 *    duplicate React keys and doubled rows.
 *  - Deleted rows (status 'D') render disabled — the file no longer exists on
 *    disk, so there is nothing to open in the viewer.
 */
import { useState, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import FileRow from './FileRow'
import { useFileViewerStore, type FileViewerCtx } from '@renderer/store/file-viewer.store'

export interface FileListEntry {
  path: string
  status?: 'M' | 'A' | 'D'
  additions?: number
  deletions?: number
}

interface FileListSectionProps {
  label: string
  /** String entries and richer { path, status, counts } entries are both accepted. */
  files: Array<string | FileListEntry>
  /** Viewer context rows are opened under (e.g. { blueprintId }). */
  ctx?: FileViewerCtx
  /** Renders a toggle header and starts collapsed (defaultOpen picks the state). */
  collapsible?: boolean
  defaultOpen?: boolean
  className?: string
}

/** Normalize + dedupe: last entry wins, first-appearance order preserved. */
function normalizeFiles(files: Array<string | FileListEntry>): FileListEntry[] {
  const byPath = new Map<string, FileListEntry>()
  for (const raw of files) {
    const entry: FileListEntry = typeof raw === 'string' ? { path: raw } : raw
    byPath.set(entry.path, entry) // Map keeps the first-insertion position on overwrite
  }
  return Array.from(byPath.values())
}

export function FileListSection({
  label,
  files,
  ctx,
  collapsible = false,
  defaultOpen,
  className
}: FileListSectionProps): JSX.Element | null {
  const entries = normalizeFiles(files)
  const openFile = useFileViewerStore((s) => s.openFile)
  const viewerActiveFile = useFileViewerStore((s) => s.activeFile)
  const [open, setOpen] = useState<boolean>(defaultOpen ?? !collapsible)

  if (entries.length === 0) return null

  const labelText = `${label} (${entries.length})`
  const list = open && (
    <div
      className="rounded-xl border border-border-subtle overflow-hidden max-h-[420px] overflow-y-auto divide-y divide-border-subtle"
      data-testid="file-list-rows"
    >
      {entries.map((f) => (
        <FileRow
          key={f.path}
          path={f.path}
          status={f.status}
          additions={f.additions}
          deletions={f.deletions}
          disabled={f.status === 'D'}
          selected={viewerActiveFile === f.path}
          onClick={() => void openFile(f.path, ctx ?? {})}
        />
      ))}
    </div>
  )

  return (
    <div className={className} data-testid="file-list-section">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 mb-2 text-xs font-semibold text-text-muted uppercase tracking-wider hover:text-text-secondary transition-colors"
          data-testid="file-list-toggle"
          aria-expanded={open}
        >
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          {labelText}
        </button>
      ) : (
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          {labelText}
        </h3>
      )}
      {list}
    </div>
  )
}

/**
 * BlueprintFileViewerDrawer — right-side file viewer shared by every blueprint
 * surface (detail view, deliverables tree). Any component that opens a file via
 * the file-viewer store (Modified Files chips, deliverable artifacts, tool
 * activity rows) gets it rendered here.
 *
 * Height strategy differs per host: the detail view scrolls with the page, so
 * the default `sticky top-0 h-screen` pins the drawer to the viewport while the
 * deliverables column scrolls. The deliverables view is a fixed-height flex box
 * with internal scrolling — pass `className="h-full max-h-full overflow-hidden"`
 * there instead.
 */
import type { JSX } from 'react'
import FileViewerPanel from '../../common/FileViewerPanel'
import { useFileViewerStore } from '@renderer/store/file-viewer.store'

interface BlueprintFileViewerDrawerProps {
  /** Height/position classes — defaults to the page-scroll sticky variant. */
  className?: string
}

export default function BlueprintFileViewerDrawer({
  className = 'sticky top-0 h-screen max-h-screen overflow-hidden'
}: BlueprintFileViewerDrawerProps): JSX.Element | null {
  const isOpen = useFileViewerStore((s) => s.isOpen)
  const activeFile = useFileViewerStore((s) => s.activeFile)

  if (!isOpen || !activeFile) return null

  return (
    <aside
      data-testid="blueprint-file-drawer"
      className={`w-[420px] flex-shrink-0 border-l border-border-subtle p-3 ${className}`}
    >
      <FileViewerPanel />
    </aside>
  )
}

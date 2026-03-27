import React, { useEffect } from 'react'
import { FileText, FileWarning, Loader2, BookOpen, MessageCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDocsStore, useWorkspaceStore } from '@renderer/store'
import { MermaidDiagram } from '@renderer/components/common'
import type { DocFile } from '../../../../shared/types'

function DocFileItem({
  doc,
  isSelected,
  onSelect
}: {
  doc: DocFile
  isSelected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm transition-colors text-left focus-visible:ring-2 focus-visible:ring-primary/50 ${
        isSelected
          ? 'bg-primary-muted text-primary-text border border-primary/20'
          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-transparent'
      }`}
    >
      <FileText size={14} className={doc.supported ? 'text-emerald-400' : 'text-text-muted'} />
      <div className="flex-1 min-w-0">
        <span className="block truncate">{doc.name}</span>
        {!doc.supported && <span className="text-xs text-amber-500/70">Not supported yet</span>}
      </div>
    </button>
  )
}

/** Markdown renderer that detects ```mermaid fenced blocks and renders them as diagrams */
function DocumentViewer({ content }: { content: string }): React.JSX.Element {
  const markdownComponents = {
    pre: ({ children }: { children?: React.ReactNode }): React.JSX.Element => {
      // Check if this pre contains a mermaid code block
      const codeChild = React.Children.toArray(children).find(
        (child): child is React.ReactElement =>
          React.isValidElement(child) && (child as React.ReactElement).type === 'code'
      )
      const className = (codeChild?.props as { className?: string })?.className || ''
      if (className.includes('language-mermaid')) {
        const code = String(
          (codeChild?.props as { children?: React.ReactNode })?.children || ''
        ).replace(/\n$/, '')
        return <MermaidDiagram definition={code} className="my-4" />
      }
      // Regular code block
      return (
        <pre className="bg-surface-base p-3 rounded-lg overflow-x-auto text-sm my-2">
          {children}
        </pre>
      )
    }
  }

  return (
    <div className="prose prose-invert prose-sm max-w-none px-6 py-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** Empty state shown when /docs doesn't exist or is empty */
function EmptyState(): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <BookOpen size={40} className="mx-auto text-text-muted" />
        <h3 className="text-lg font-semibold text-text-primary">No documents found</h3>
        <p className="text-sm text-text-secondary">
          Your workspace doesn&apos;t have a{' '}
          <code className="px-1.5 py-0.5 rounded bg-surface-overlay text-primary-text text-xs">
            docs/
          </code>{' '}
          folder yet, or it&apos;s empty.
        </p>
        <div className="rounded-lg border border-border-subtle bg-surface-overlay p-4 text-left space-y-3">
          <p className="text-xs text-text-secondary font-medium flex items-center gap-1.5">
            <MessageCircle size={12} className="text-emerald-400" />
            Try asking the Docs &amp; Diagrams specialist:
          </p>
          <div className="rounded-md bg-surface-base px-3 py-2">
            <code className="text-xs text-emerald-400 whitespace-pre-wrap">
              &quot;Generate a sequence diagram showing the auto-update flow and save it to
              docs/&quot;
            </code>
          </div>
          <p className="text-xs text-text-muted">
            The specialist will create Mermaid diagrams in your{' '}
            <code className="text-text-secondary">docs/</code> folder, and they&apos;ll appear here
            automatically.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Unsupported format placeholder */
function UnsupportedFormat({ doc }: { doc: DocFile }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center space-y-3">
        <FileWarning size={32} className="mx-auto text-amber-500/60" />
        <h3 className="text-sm font-semibold text-text-primary">{doc.name}</h3>
        <p className="text-xs text-text-secondary">
          <code className="px-1 py-0.5 rounded bg-surface-overlay text-amber-400">
            .{doc.extension}
          </code>{' '}
          files are not supported yet. Markdown (<code className="text-text-secondary">.md</code>)
          files with Mermaid diagrams are currently supported.
        </p>
      </div>
    </div>
  )
}

export default function DocumentsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { docs, selectedDoc, docContent, isLoading, loadDocs, selectDoc, loadDocContent, reset } =
    useDocsStore()

  const workspacePath = activeWorkspace?.repoPath ?? null

  useEffect(() => {
    if (workspacePath) loadDocs(workspacePath)
    return () => reset()
  }, [workspacePath, loadDocs, reset])

  const handleSelectDoc = (doc: DocFile): void => {
    selectDoc(doc)
    if (doc.supported) loadDocContent(doc)
  }

  // No workspace
  if (!workspacePath) return <EmptyState />

  // Loading
  if (isLoading && docs.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={18} className="animate-spin text-text-secondary" />
        <span className="ml-2 text-sm text-text-secondary">Scanning docs folder...</span>
      </div>
    )
  }

  // No docs folder or empty
  if (docs.length === 0) return <EmptyState />

  return (
    <div className="flex flex-1 min-h-0">
      {/* File list sidebar */}
      <div className="w-[220px] border-r border-border-subtle p-3 overflow-y-auto flex-shrink-0">
        <div className="text-xs text-text-muted uppercase tracking-wider font-semibold px-3 mb-2">
          docs/
        </div>
        <div className="space-y-0.5">
          {docs.map((doc) => (
            <DocFileItem
              key={doc.path}
              doc={doc}
              isSelected={selectedDoc?.path === doc.path}
              onSelect={() => handleSelectDoc(doc)}
            />
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {!selectedDoc ? (
          <div className="flex items-center justify-center h-full text-sm text-text-secondary">
            Select a document to view
          </div>
        ) : !selectedDoc.supported ? (
          <UnsupportedFormat doc={selectedDoc} />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={18} className="animate-spin text-text-secondary" />
          </div>
        ) : (
          <DocumentViewer content={docContent ?? ''} />
        )}
      </div>
    </div>
  )
}

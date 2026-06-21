import { useState, useEffect } from 'react'
import { Save, Loader2, Pencil, Eye } from 'lucide-react'
import CodeEditor from './CodeEditor'

interface MarkdownViewerProps {
  filePath: string
  initialContent: string
  onSave: (content: string) => Promise<void>
  readOnly?: boolean
}

export default function MarkdownViewer({
  filePath,
  initialContent,
  onSave,
  readOnly = false
}: MarkdownViewerProps): React.JSX.Element {
  const [content, setContent] = useState(initialContent)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync local state from prop
    setContent(initialContent)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasChanges(false)
  }, [initialContent])

  const handleChange = (value: string): void => {
    setContent(value)
    setHasChanges(value !== initialContent)
    setError(null)
  }

  const handleSave = async (): Promise<void> => {
    if (!hasChanges || readOnly) return
    setIsSaving(true)
    setError(null)
    try {
      await onSave(content)
      setHasChanges(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div data-testid="markdown-viewer" className="flex flex-col gap-2">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-muted font-mono truncate">{filePath}</span>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <button
              data-testid="markdown-edit-toggle"
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                isEditing
                  ? 'bg-primary-muted text-primary-text'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
              }`}
            >
              {isEditing ? (
                <>
                  <Eye size={12} />
                  Preview
                </>
              ) : (
                <>
                  <Pencil size={12} />
                  Edit
                </>
              )}
            </button>
          )}
          {!readOnly && hasChanges && (
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-medium transition-colors"
            >
              {isSaving ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={12} />
                  Save
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/20 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Content */}
      {isEditing ? (
        <CodeEditor
          value={content}
          onChange={handleChange}
          language="markdown"
          className="flex-1 min-h-[400px] max-h-[600px]"
        />
      ) : (
        <div className="rounded-lg border border-border-subtle bg-surface-base p-4 overflow-auto max-h-[600px]">
          <pre className="text-sm text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

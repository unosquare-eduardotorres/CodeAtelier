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
    setContent(initialContent)
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
    <div className="flex flex-col gap-2">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gray-500 font-mono truncate">{filePath}</span>
        <div className="flex items-center gap-2">
          {!readOnly && (
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                isEditing
                  ? 'bg-indigo-600/20 text-indigo-400'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
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
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
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
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 overflow-auto max-h-[600px]">
          <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

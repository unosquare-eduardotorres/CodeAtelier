import { useState, useEffect } from 'react'
import { Save, Loader2 } from 'lucide-react'
import CodeEditor from './CodeEditor'

interface AgentYamlEditorProps {
  filePath: string
  initialContent: string
  onSave: (content: string) => Promise<void>
  readOnly?: boolean
}

export default function AgentYamlEditor({
  filePath,
  initialContent,
  onSave,
  readOnly = false
}: AgentYamlEditorProps): React.JSX.Element {
  const [content, setContent] = useState(initialContent)
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
        <span className="text-[11px] text-text-muted font-mono truncate">{filePath}</span>
        {!readOnly && (
          <button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              hasChanges
                ? 'bg-primary hover:bg-primary-hover text-white'
                : 'bg-surface-raised text-text-muted cursor-not-allowed'
            }`}
          >
            {isSaving ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save size={12} />
                Save Changes
              </>
            )}
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/20 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Editor */}
      <CodeEditor
        value={content}
        onChange={handleChange}
        language="yaml"
        readOnly={readOnly}
        className="flex-1 min-h-[400px] max-h-[600px]"
      />
    </div>
  )
}

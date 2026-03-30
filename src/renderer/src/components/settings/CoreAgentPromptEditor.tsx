import { useState, useEffect, useCallback } from 'react'
import { Save, RotateCcw, Loader2, AlertTriangle } from 'lucide-react'
import { useProfileStore } from '@renderer/store'

interface CoreAgentPromptEditorProps {
  agentRole: 'generalist'
}

type ModeTab = 'plan' | 'build'

export default function CoreAgentPromptEditor({
  agentRole
}: CoreAgentPromptEditorProps): React.JSX.Element {
  const {
    coreAgentPrompts,
    loadCoreAgentPrompts,
    saveCoreAgentPrompt,
    resetCoreAgentPrompt,
    getCoreAgentPrompt
  } = useProfileStore()

  const [activeMode, setActiveMode] = useState<ModeTab>('plan')
  const [editedText, setEditedText] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Load prompts on mount
  useEffect(() => {
    if (coreAgentPrompts.length === 0) {
      loadCoreAgentPrompts()
    }
  }, [coreAgentPrompts.length, loadCoreAgentPrompts])

  // Get active prompt from store
  const activePrompt = getCoreAgentPrompt(agentRole, activeMode)

  // Sync editor text when prompt loads or mode changes
  useEffect(() => {
    if (activePrompt) {
      setEditedText(activePrompt.promptText)
    }
    setError(null)
    setSaved(false)
    setShowResetConfirm(false)
  }, [activePrompt?.id, activeMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasChanges = activePrompt ? editedText !== activePrompt.promptText : false
  const isCustom = activePrompt?.isCustom ?? false
  const charCount = editedText.length

  const handleSave = useCallback(async () => {
    if (!editedText.trim()) {
      setError('Prompt cannot be empty')
      return
    }
    setIsSaving(true)
    setError(null)
    setSaved(false)
    try {
      await saveCoreAgentPrompt(agentRole, activeMode, editedText)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSaving(false)
    }
  }, [agentRole, activeMode, editedText, saveCoreAgentPrompt])

  const handleReset = useCallback(async () => {
    setIsResetting(true)
    setError(null)
    try {
      await resetCoreAgentPrompt(agentRole, activeMode)
      setShowResetConfirm(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsResetting(false)
    }
  }, [agentRole, activeMode, resetCoreAgentPrompt])

  if (!activePrompt) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <Loader2 size={14} className="animate-spin" />
          Loading prompts...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Mode tabs */}
      <div className="flex items-center justify-between">
        <div className="flex items-center bg-surface-base border border-border-subtle rounded-lg p-0.5">
          {(['plan', 'build'] as const).map((mode) => {
            const prompt = getCoreAgentPrompt(agentRole, mode)
            return (
              <button
                key={mode}
                onClick={() => setActiveMode(mode)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors relative ${
                  activeMode === mode
                    ? 'bg-primary/20 text-primary-text'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
                }`}
              >
                {mode === 'plan' ? 'Plan Mode' : 'Build Mode'}
                {prompt?.isCustom && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-mode-plan" title="Customized" />
                )}
              </button>
            )
          })}
        </div>

        {/* Custom badge */}
        {isCustom && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-mode-plan-muted text-mode-plan-text border border-mode-plan/30">
            Custom
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/20 text-xs text-danger">
          {error}
        </div>
      )}

      {/* Editor */}
      <textarea
        value={editedText}
        onChange={(e) => setEditedText(e.target.value)}
        rows={16}
        className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-xs text-text-primary
          placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50
          transition-colors resize-y font-mono leading-relaxed"
        spellCheck={false}
      />

      {/* Footer: char count + actions */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-muted">
          {charCount.toLocaleString()} chars
        </span>

        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs text-success font-medium">Saved!</span>
          )}

          {/* Reset to Default */}
          {isCustom && !showResetConfirm && (
            <button
              onClick={() => setShowResetConfirm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                text-text-secondary border border-border-subtle hover:bg-surface-float
                transition-colors"
            >
              <RotateCcw size={12} />
              Reset to Default
            </button>
          )}

          {/* Save Prompt */}
          <button
            onClick={handleSave}
            disabled={isSaving || !hasChanges || !editedText.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
              bg-primary text-white hover:bg-primary-hover
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save Prompt
          </button>
        </div>
      </div>

      {/* Reset confirmation */}
      {showResetConfirm && (
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-warning-muted border border-warning/20">
          <AlertTriangle size={14} className="text-warning flex-shrink-0" />
          <p className="text-xs text-text-secondary flex-1">
            This will restore the original shipped prompt. Your customizations will be lost.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowResetConfirm(false)}
              className="px-2.5 py-1 rounded text-xs font-medium text-text-secondary hover:bg-surface-float transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleReset}
              disabled={isResetting}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium
                bg-danger text-white hover:bg-danger/80
                disabled:opacity-50 transition-colors"
            >
              {isResetting ? <Loader2 size={10} className="animate-spin" /> : null}
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

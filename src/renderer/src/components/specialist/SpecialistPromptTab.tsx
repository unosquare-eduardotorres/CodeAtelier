import { useEffect, useState } from 'react'
import { Hammer, Save } from 'lucide-react'
import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

interface Props {
  specialist: ProjectSpecialist
}

export default function SpecialistPromptTab({ specialist }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(specialist.prompt)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const rebuildPrompt = useProjectSpecialistStore((s) => s.rebuildPrompt)
  const updatePrompt = useProjectSpecialistStore((s) => s.updatePrompt)

  useEffect(() => {
    setDraft(specialist.prompt)
    setDirty(false)
  }, [specialist.id, specialist.prompt])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      await updatePrompt(specialist.id, draft)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleRebuild(): Promise<void> {
    setSaving(true)
    try {
      await rebuildPrompt(specialist.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          {specialist.prompt.length} chars · Last built{' '}
          {specialist.lastBuiltAt
            ? new Date(specialist.lastBuiltAt).toLocaleString()
            : 'never'}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleRebuild}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            <Hammer className="h-3 w-3" /> Rebuild
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Save className="h-3 w-3" /> Save
          </button>
        </div>
      </div>

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setDirty(e.target.value !== specialist.prompt)
        }}
        spellCheck={false}
        className="flex-1 min-h-[320px] w-full resize-y rounded-md border border-slate-300 bg-white p-3 font-mono text-xs leading-relaxed shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800"
      />
    </div>
  )
}

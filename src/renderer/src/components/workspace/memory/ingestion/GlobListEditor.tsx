import { useState } from 'react'
import { Plus, X } from 'lucide-react'

import { Button } from '@renderer/components/common/ui'

/**
 * Editor for the extra instruction-file globs.
 *
 * Standard locations (AGENTS.md, .cursor/rules, nested CLAUDE.md, …) are found
 * automatically; this list is only for layouts that put them elsewhere, so it
 * starts empty and stays small.
 */
export default function GlobListEditor({
  globs,
  onChange
}: {
  globs: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const value = draft.trim()
    if (!value || globs.includes(value)) return
    onChange([...globs, value])
    setDraft('')
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="packages/*/AGENTS.md"
          aria-label="Instruction file glob"
          className="flex-1 h-8 px-2 text-sm bg-input-bg border border-border-default rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-input-focus"
        />
        <Button variant="secondary" size="md" onClick={add} disabled={!draft.trim()}>
          <Plus className="w-3.5 h-3.5" /> Add
        </Button>
      </div>

      {globs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {globs.map((glob) => (
            <li
              key={glob}
              className="flex items-center justify-between gap-2 px-2 py-1 bg-surface-float border border-border-default rounded text-xs"
            >
              <span className="font-mono text-text-secondary truncate">{glob}</span>
              <button
                type="button"
                onClick={() => onChange(globs.filter((g) => g !== glob))}
                aria-label={`Remove ${glob}`}
                className="p-0.5 text-text-muted hover:text-danger shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

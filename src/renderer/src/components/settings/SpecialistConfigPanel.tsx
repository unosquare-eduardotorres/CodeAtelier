import { useState, useEffect } from 'react'
import { X, Save, FileCode } from 'lucide-react'
import type { MarketplaceSpecialist } from '../../../../shared/types'

interface SpecialistConfigPanelProps {
  specialist: MarketplaceSpecialist
  onSave: (data: {
    displayName?: string
    icon?: string
    color?: string
    alias?: string | null
  }) => Promise<void>
  onClose: () => void
}

export default function SpecialistConfigPanel({
  specialist,
  onSave,
  onClose
}: SpecialistConfigPanelProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(specialist.displayName)
  const [alias, setAlias] = useState(specialist.alias ?? '')
  const [icon, setIcon] = useState(specialist.icon)
  const [color, setColor] = useState(specialist.color)
  const [isSaving, setIsSaving] = useState(false)
  const [showYaml, setShowYaml] = useState(false)
  const [yamlContent, setYamlContent] = useState<string | null>(null)

  useEffect(() => {
    setDisplayName(specialist.displayName)
    setAlias(specialist.alias ?? '')
    setIcon(specialist.icon)
    setColor(specialist.color)
  }, [specialist])

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    try {
      await onSave({
        displayName: displayName !== specialist.displayName ? displayName : undefined,
        icon: icon !== specialist.icon ? icon : undefined,
        color: color !== specialist.color ? color : undefined,
        alias: alias !== (specialist.alias ?? '') ? alias || null : undefined
      })
      onClose()
    } finally {
      setIsSaving(false)
    }
  }

  const loadYaml = async (): Promise<void> => {
    try {
      const path = `.claude/agents/${specialist.agentId}.yml`
      const content = await window.api.readWorkspaceFile({ filePath: path })
      setYamlContent(content)
      setShowYaml(true)
    } catch {
      setYamlContent('# YAML file not found or not deployed')
      setShowYaml(true)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-lg text-lg"
              style={{ backgroundColor: `${color}20` }}
            >
              {icon}
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Configure Specialist</h2>
              <p className="text-xs text-text-secondary">{specialist.agentId}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Display Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary
                focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
              placeholder="Specialist name"
            />
          </div>

          {/* Alias */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Alias <span className="text-text-muted">(optional nickname shown in chat)</span>
            </label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary
                focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
              placeholder="e.g. Sparky"
            />
          </div>

          {/* Icon + Color row */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Icon</label>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary
                  focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors text-center"
                maxLength={4}
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-9 h-9 rounded-lg border border-border-subtle cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-sm text-text-primary
                    focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors font-mono"
                  placeholder="#000000"
                />
              </div>
            </div>
          </div>

          {/* Skills (read-only) */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Attached Skills
            </label>
            {specialist.skills.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {specialist.skills.map((skill) => (
                  <span
                    key={skill.id}
                    className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-surface-float text-text-secondary border border-border-subtle"
                  >
                    {skill.name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No skills attached</p>
            )}
          </div>

          {/* YAML Preview toggle */}
          <div>
            <button
              onClick={loadYaml}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              <FileCode size={12} />
              {showYaml ? 'YAML Preview' : 'View Agent YAML'}
            </button>
            {showYaml && yamlContent && (
              <pre className="mt-2 p-3 rounded-lg bg-surface-base border border-border-subtle text-xs text-text-secondary overflow-x-auto max-h-48 overflow-y-auto font-mono">
                {yamlContent}
              </pre>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !displayName.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium
              bg-primary text-white hover:bg-primary-hover
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save size={12} />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

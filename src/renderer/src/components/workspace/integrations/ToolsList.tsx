import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'

export default function ToolsList({
  integration
}: {
  integration: ExternalMcpDefinition
}): React.JSX.Element {
  const [showTools, setShowTools] = useState(false)

  return (
    <div className="space-y-1">
      <button
        onClick={() => setShowTools(!showTools)}
        aria-expanded={showTools}
        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        {showTools ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>
          {integration.toolCount} tools ({integration.planModeToolNames.length} available in plan
          mode)
        </span>
      </button>
      {showTools && (
        <div className="bg-surface-base rounded-md p-2.5 space-y-2.5">
          {integration.toolNames.map((name) => {
            const shortName = name.replace(`mcp__${integration.id}__`, '')
            const isPlanMode = integration.planModeToolNames.includes(name)
            const description = integration.toolDescriptions?.[name]

            return (
              <div key={name} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <code className="text-text-primary font-mono text-[11px] font-semibold">
                    {shortName}
                  </code>
                  {isPlanMode && (
                    <span className="text-[11px] px-1 py-0.5 rounded bg-mode-plan-muted text-mode-plan-text">
                      plan
                    </span>
                  )}
                  {!isPlanMode && (
                    <span className="text-[11px] px-1 py-0.5 rounded bg-mode-build-muted text-mode-build-text">
                      build only
                    </span>
                  )}
                </div>
                {description && (
                  <p className="text-[11px] text-text-muted leading-relaxed pl-0.5">
                    {description}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

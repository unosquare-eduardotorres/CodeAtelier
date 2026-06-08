import { Cloud, Cpu } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { ExecutorBackend } from '../../../../../shared/types'

interface ExecutorBackendSectionProps {
  executorBackend: ExecutorBackend
  isLocalLLM?: boolean
  activeWorkspaceId: string
  onBackendChange: (backend: ExecutorBackend) => void
}

export default function ExecutorBackendSection({
  executorBackend,
  isLocalLLM,
  activeWorkspaceId,
  onBackendChange
}: ExecutorBackendSectionProps): React.JSX.Element {
  return (
    <div className="mb-8">
      <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
        Execution Backend
      </h3>
      <SettingsCard>
        <div className="mb-4">
          <h4 className="text-sm font-medium text-text-primary">AI Runtime</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            {isLocalLLM
              ? '⚡ Running via OpenCode (Ollama/oMLX)'
              : '☁️ Running via Claude CLI (Max subscription)'}
          </p>
        </div>
        <div className="flex gap-2">
          {[
            {
              value: 'cli' as ExecutorBackend,
              label: 'Claude CLI',
              desc: 'Max subscription billing',
              icon: <Cloud size={14} />
            },
            {
              value: 'opencode' as ExecutorBackend,
              label: 'OpenCode',
              desc: 'Multi-provider runtime (Ollama/oMLX)',
              icon: <Cpu size={14} />
            }
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => onBackendChange(opt.value)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
                executorBackend === opt.value
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
              data-workspace-id={activeWorkspaceId}
            >
              {opt.icon}
              <div className="text-left">
                <div>{opt.label}</div>
                <div className="text-[10px] font-normal text-text-muted">{opt.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </SettingsCard>
    </div>
  )
}

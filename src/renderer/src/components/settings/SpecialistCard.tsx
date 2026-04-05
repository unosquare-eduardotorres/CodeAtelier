import { useState } from 'react'
import { Loader2, Settings, Zap, Brain, Sparkles, Shield } from 'lucide-react'
import type { MarketplaceSpecialist } from '../../../../shared/types'
import { AgentIcon, AGENT_ICON_MAP } from '@renderer/assets/agent-icons'
import { Avatar, PixelSpriteAvatar } from '@renderer/components/common'
import { getSpriteAssignment } from '@renderer/components/pixel-office/agentMapping'

interface SpecialistCardProps {
  specialist: MarketplaceSpecialist
  isDeploying: boolean
  onDeploy: () => void
  onUndeploy: () => void
  onConfigure: () => void
}

const MODEL_BADGES: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  opus: {
    label: 'Opus',
    icon: <Brain size={10} />,
    className: 'bg-mode-plan-muted text-mode-plan-text border-mode-plan/30'
  },
  sonnet: {
    label: 'Sonnet',
    icon: <Sparkles size={10} />,
    className: 'bg-info-muted text-info border-info/30'
  },
  haiku: {
    label: 'Haiku',
    icon: <Zap size={10} />,
    className: 'bg-success-muted text-success border-success/30'
  }
}

export default function SpecialistCard({
  specialist,
  isDeploying,
  onDeploy,
  onUndeploy,
  onConfigure
}: SpecialistCardProps): React.JSX.Element {
  const [isHovered, setIsHovered] = useState(false)

  const modelBadge = MODEL_BADGES[specialist.model] ?? MODEL_BADGES.sonnet

  const isActive = specialist.isActive && specialist.isDeployed

  return (
    <div
      className={`
        relative bg-surface-overlay border rounded p-4 shadow-sm
        transition-all duration-200 min-h-[140px] flex flex-col
        ${isActive ? 'border-success/40 hover:border-success/60' : 'border-border-subtle hover:border-border-default'}
        ${isHovered ? 'shadow-md' : ''}
      `}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      tabIndex={0}
      role="article"
      aria-label={`${specialist.displayName} specialist${isActive ? ', active' : ', available'}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onConfigure()
        if (e.key === ' ') {
          e.preventDefault()
          isActive ? onUndeploy() : onDeploy()
        }
      }}
    >
      {/* Status indicator */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onConfigure()
          }}
          className="p-1.5 rounded-md hover:bg-surface-float text-text-muted hover:text-text-primary transition-colors"
          aria-label={`Configure ${specialist.displayName}`}
          title="Configure"
        >
          <Settings size={14} />
        </button>
        <div
          className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-neutral-500'}`}
          title={isActive ? 'Active & Deployed' : 'Available'}
        />
      </div>

      {/* Icon + Name */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-sm flex-shrink-0 overflow-hidden"
          style={{ backgroundColor: `${specialist.color}18`, border: `1px solid ${specialist.color}35` }}
        >
          {(specialist.pixelSpriteId || getSpriteAssignment(specialist.agentId).pixelSpriteId) ? (
            <PixelSpriteAvatar
              spriteId={specialist.pixelSpriteId ?? getSpriteAssignment(specialist.agentId).pixelSpriteId!}
              size={32}
            />
          ) : specialist.avatarUrl ? (
            <Avatar avatarKey={specialist.avatarUrl} size="sm" accentColor={specialist.color} />
          ) : AGENT_ICON_MAP[specialist.agentId] ? (
            <AgentIcon agentType={specialist.agentId} size={28} />
          ) : (
            <span className="text-lg leading-none">{specialist.icon}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text-primary truncate pr-12">
            {specialist.alias || specialist.displayName}
          </h3>
          <p className="text-xs text-text-secondary line-clamp-2 mt-0.5">
            {specialist.description}
          </p>
        </div>
      </div>

      {/* Model + Skills + Core badge */}
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        {specialist.isCore && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-mode-plan-muted text-mode-plan-text border border-mode-plan/30">
            <Shield size={9} />
            Core
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${modelBadge.className}`}
        >
          {modelBadge.icon}
          {modelBadge.label}
        </span>
        {specialist.skills.slice(0, 3).map((skill) => (
          <span
            key={skill.id}
            className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-float text-text-muted border border-border-subtle truncate max-w-[100px]"
            title={skill.name}
          >
            {skill.name}
          </span>
        ))}
        {specialist.skills.length > 3 && (
          <span className="text-[10px] text-text-muted">+{specialist.skills.length - 3}</span>
        )}
      </div>

      {/* Deploy/Undeploy button */}
      <div className="mt-auto">
        {specialist.isCore ? (
          <div className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
            text-text-muted border border-border-subtle/50 bg-surface-float/30 cursor-default min-h-[36px]">
            <Shield size={12} />
            Core Agent &middot; Always Active
          </div>
        ) : isActive ? (
          <button
            onClick={onUndeploy}
            disabled={isDeploying}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              text-danger border border-danger/30 hover:bg-danger-muted
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[36px]"
          >
            {isDeploying ? <Loader2 size={12} className="animate-spin" /> : 'Undeploy'}
          </button>
        ) : (
          <button
            onClick={onDeploy}
            disabled={isDeploying}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
              text-success border border-success/30 hover:bg-success-muted
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[36px]"
          >
            {isDeploying ? <Loader2 size={12} className="animate-spin" /> : 'Deploy'}
          </button>
        )}
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { Users } from 'lucide-react'
import { Avatar } from '@renderer/components/common'
import { CORE_AGENT_DEFAULTS } from '@renderer/utils/agentIdentity'
import type { CoreAgentAlias } from '../../../../shared/types'

interface CoreAgentCard {
  id: string
  name: string
  avatarKey: string
  description: string
  usedIn: string[]
  accentColor: string
}

const CORE_AGENT_DESCRIPTIONS: Record<string, { description: string; usedIn: string[] }> = {
  specialist: {
    description:
      'Your primary development partner for planning, building, code review, and technical exploration.',
    usedIn: ['Chat', 'Grill', 'Plan', 'Build']
  }
}

export default function CoreTeamPage(): React.JSX.Element {
  const [aliases, setAliases] = useState<CoreAgentAlias[]>([])

  useEffect(() => {
    window.api.listCoreAgentAliases().then(setAliases).catch(console.error)
  }, [])

  // Build card data from core agent aliases + defaults
  const cards: CoreAgentCard[] = Object.entries(CORE_AGENT_DEFAULTS).map(([agentId, defaults]) => {
    const alias = aliases.find((a) => a.agentRole === agentId)
    const meta = CORE_AGENT_DESCRIPTIONS[agentId]
    return {
      id: agentId,
      name: alias?.alias ?? defaults.displayName,
      avatarKey: alias?.avatarKey ?? defaults.avatarKey,
      description: meta?.description ?? 'Core agent',
      usedIn: meta?.usedIn ?? [],
      accentColor: defaults.color
    }
  })

  return (
    <div data-testid="core-team-page" className="p-6">
      <div className="flex items-center gap-2 mb-2">
        <Users size={16} className="text-primary-text" />
        <h3 className="text-sm font-semibold text-text-primary">Core Team</h3>
      </div>
      <p className="text-xs text-text-secondary mb-6">
        Built-in agents that power your workspace. These agents are always available.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <div
            key={card.id}
            data-testid="core-agent-card"
            className="group relative flex flex-col items-center text-center p-6 rounded-xl border border-border-subtle bg-surface-overlay hover:border-primary/30 hover:shadow-md transition-all"
          >
            {/* Avatar */}
            <div className="mb-4">
              <Avatar avatarKey={card.avatarKey} size="xl" accentColor={card.accentColor} />
            </div>

            {/* Name */}
            <h4
              className="text-lg font-medium text-text-primary mb-0.5"
              style={{ fontFamily: 'var(--ca-font-display)', letterSpacing: '0.01em' }}
            >
              {card.name}
            </h4>
            <span className="text-xs text-text-muted mb-3">Core Agent</span>

            {/* Description */}
            <p className="text-sm text-text-secondary leading-relaxed mb-4">{card.description}</p>

            {/* Used In badges */}
            {card.usedIn.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5 mt-auto">
                {card.usedIn.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full bg-primary-muted text-primary-text border border-primary/20"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

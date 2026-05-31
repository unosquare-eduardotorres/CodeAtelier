/**
 * TeamPage — orchestrator for the team management page.
 * Delegates to AgentManagementSection and SkillManagementSection with
 * cross-navigation via imperative handles.
 *
 * Decomposed from original 1137-line monolith (Round 3).
 */

import { useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { useSpecialistStore } from '@renderer/store'
import {
  AgentManagementSection,
  SkillManagementSection,
  useTeamPageData,
  type AgentManagementHandle,
  type SkillManagementHandle
} from './team'

// ── Props ──

interface TeamPageProps {
  workspacePath: string
}

// ── Component ──

export default function TeamPage({ workspacePath }: TeamPageProps): React.JSX.Element {
  const { agents, skills, deployAll } = useSettingsStore()
  const { specialists } = useSpecialistStore()
  const [isDeploying, setIsDeploying] = useState(false)

  // Shared computed data
  const { skillAgentMap, sortedAgents, sortedSkills, activeAgents, inactiveAgents } =
    useTeamPageData(agents, skills, specialists)

  // Cross-navigation handles
  const agentSectionRef = useRef<AgentManagementHandle>(null)
  const skillSectionRef = useRef<SkillManagementHandle>(null)

  const handleAutoActivate = async (): Promise<void> => {
    setIsDeploying(true)
    try {
      await deployAll(workspacePath)
    } finally {
      setIsDeploying(false)
    }
  }

  // ── Empty state: no agents deployed at all ──

  if (sortedAgents.length === 0 && sortedSkills.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-primary-muted flex items-center justify-center mb-4">
              <Sparkles size={28} className="text-primary-text" />
            </div>
            <h3 className="text-base font-semibold text-text-primary mb-2">Get Started</h3>
            <p className="text-sm text-text-secondary max-w-md mb-6">
              Activate specialist agents for this workspace. Each can be individually activated or
              deactivated as needed for your project.
            </p>
            <button
              onClick={handleAutoActivate}
              disabled={isDeploying}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label="Auto-activate specialist agents"
            >
              {isDeploying ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Activating...
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Auto-Activate Team
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main layout ──

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-8">
        {/* Section A: Agents */}
        <AgentManagementSection
          ref={agentSectionRef}
          workspacePath={workspacePath}
          agents={agents}
          activeAgents={activeAgents}
          inactiveAgents={inactiveAgents}
          onSkillClick={(name) => skillSectionRef.current?.scrollToSkill(name)}
        />

        {/* Section B: Skills */}
        <SkillManagementSection
          ref={skillSectionRef}
          workspacePath={workspacePath}
          skills={skills}
          sortedSkills={sortedSkills}
          skillAgentMap={skillAgentMap}
          onAgentClick={(name) => agentSectionRef.current?.scrollToAgent(name)}
        />
      </div>
    </div>
  )
}

/**
 * Shared phase display configuration — icons, labels, descriptions, colors.
 * Single source of truth consumed by Timeline, Stream, landing cards, and onboard modal.
 */

import type { ComponentType } from 'react'
import { ClipboardList, HelpCircle, Map, ListTodo, Search, Hammer, ShieldCheck } from 'lucide-react'
import type { BlueprintPhaseType } from '../../../../../shared/blueprint-types'

export interface PhaseDisplayConfig {
  label: string
  agentLabel: string // "Specifier", "Planner" — used in stream header
  icon: ComponentType<{ size?: number; className?: string }>
  color: string // Tailwind text color class
  hexColor: string // For SVG / non-Tailwind contexts
  description: string
}

export const PHASE_CONFIG: Record<BlueprintPhaseType, PhaseDisplayConfig> = {
  specify: {
    label: 'Specify',
    agentLabel: 'Specifier',
    icon: ClipboardList,
    color: 'text-info',
    hexColor: '#3b82f6',
    description: 'Analyze the feature and produce a detailed specification'
  },
  clarify: {
    label: 'Clarify',
    agentLabel: 'Clarifier',
    icon: HelpCircle,
    color: 'text-warning',
    hexColor: '#fbbf24',
    description: 'Ask clarifying questions about ambiguous requirements'
  },
  plan: {
    label: 'Plan',
    agentLabel: 'Planner',
    icon: Map,
    color: 'text-accent',
    hexColor: '#a78bfa',
    description: 'Create a detailed implementation plan with file paths and steps'
  },
  tasks: {
    label: 'Tasks',
    agentLabel: 'Task Builder',
    icon: ListTodo,
    color: 'text-info',
    hexColor: '#22d3ee',
    description: 'Break the plan into ordered tasks with dependency waves'
  },
  review: {
    label: 'Review',
    agentLabel: 'Reviewer',
    icon: Search,
    color: 'text-warning',
    hexColor: '#fb923c',
    description: 'Review the plan and tasks for completeness and correctness'
  },
  build: {
    label: 'Build',
    agentLabel: 'Builder',
    icon: Hammer,
    color: 'text-accent',
    hexColor: '#34d399',
    description: 'Execute tasks in dependency-ordered waves'
  },
  verify: {
    label: 'Verify',
    agentLabel: 'Verifier',
    icon: ShieldCheck,
    color: 'text-success',
    hexColor: '#2dd4bf',
    description: 'Run quality checks to confirm the implementation is correct'
  }
}

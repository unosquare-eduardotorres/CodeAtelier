/**
 * Phase icon map — single source of truth for Blueprint phase icons.
 *
 * Used by BlueprintPhaseTimeline, BlueprintPhaseStream, BlueprintPage (landing cards),
 * and BlueprintApprovalGate. Replaces scattered emoji constants.
 */
import {
  ClipboardList,
  MessageCircleQuestion,
  Map,
  ListTodo,
  SearchCheck,
  Hammer,
  ScanEye,
  CheckCircle2,
  UserCheck,
  type LucideIcon
} from 'lucide-react'

export type PhaseIconKey =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'review'
  | 'build'
  | 'code-review'
  | 'verify'
export type GateIconKey = 'approval'

export interface PhaseIconConfig {
  icon: LucideIcon
  label: string
  description: string
}

export const PHASE_ICONS: Record<PhaseIconKey, PhaseIconConfig> = {
  specify: {
    icon: ClipboardList,
    label: 'Specify',
    description: 'Analyze the feature and produce a detailed specification'
  },
  clarify: {
    icon: MessageCircleQuestion,
    label: 'Clarify',
    description: 'Ask clarifying questions about ambiguous requirements'
  },
  plan: {
    icon: Map,
    label: 'Plan',
    description: 'Create a detailed implementation plan with file paths and steps'
  },
  tasks: {
    icon: ListTodo,
    label: 'Tasks',
    description: 'Break the plan into ordered tasks with dependency waves'
  },
  review: {
    icon: SearchCheck,
    label: 'Review',
    description: 'Review the plan and tasks for completeness and correctness'
  },
  build: {
    icon: Hammer,
    label: 'Build',
    description: 'Execute tasks in parallel waves across the codebase'
  },
  'code-review': {
    icon: ScanEye,
    label: 'Code Review',
    description: 'Adversarial whole-diff review by an independent model'
  },
  verify: {
    icon: CheckCircle2,
    label: 'Verify',
    description: 'Run quality checks to confirm the implementation is correct'
  }
}

export const GATE_ICON: { icon: LucideIcon; label: string; description: string } = {
  icon: UserCheck,
  label: 'Approval Gate',
  description: 'Review and approve before building'
}

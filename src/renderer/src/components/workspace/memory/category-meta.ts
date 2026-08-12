import type { MemoryFactCategory } from '../../../../../shared/types'

/**
 * Category metadata shared by CategoryBadge, FactRow and the memories
 * toolbar. Kept out of the component file so importing it does not break
 * React Fast Refresh.
 */
export const CATEGORY_META: Record<
  MemoryFactCategory,
  { label: string; color: string; description: string; example: string }
> = {
  decision: {
    label: 'Decision',
    color: 'bg-info-muted text-info',
    description: 'Architectural or technology choices',
    example: '"Chose PostgreSQL over MongoDB for ACID compliance"'
  },
  convention: {
    label: 'Convention',
    color: 'bg-success-muted text-success',
    description: 'Patterns the codebase follows',
    example: '"All API endpoints follow REST naming conventions"'
  },
  gotcha: {
    label: 'Gotcha',
    color: 'bg-mode-build-muted text-mode-build-text',
    description: 'Traps and non-obvious constraints',
    example: '"Test DB must be reset before integration tests"'
  },
  preference: {
    label: 'Preference',
    color: 'bg-mode-plan-muted text-mode-plan-text',
    description: 'How you like things done',
    example: '"Prefer concise code over verbose comments"'
  },
  reference: {
    label: 'Reference',
    color: 'bg-surface-float text-text-secondary border border-border-subtle',
    description: 'Pointers to docs and files',
    example: '"Auth flow documented in docs/auth-architecture.md"'
  }
}

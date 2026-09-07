/**
 * The Impeccable design command catalogue and its selection rules.
 *
 * Pure and dependency-free so both main and renderer can import it and the
 * whole thing is unit-testable without a DB or IPC.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * The 16 ids, their grouping and the descriptions below are taken from the
 * engine's own `scripts/command-metadata.json` and the SKILL.md `argument-hint`
 * families (engine v0.1.3), not invented here. The engine ships 23 commands;
 * these are the ones that make sense as cards:
 *   • excluded as out of scope — `shape` (new-surface planning), `init`,
 *     `document`, `extract`, `live`, and the deprecated alias `craft`
 *   • excluded for now — `overdrive` (technically ambitious effects); it is a
 *     legitimate refine command and can be added later without other changes.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 * Only the `evaluate` commands ever run as agent sessions. Every other card is
 * a *routing* signal: it tells the generated remediation brief which Impeccable
 * fix command should address a cluster of findings. Nothing here mutates code.
 */
import type { DesignCommandDef, DesignCommandId } from './types'

/**
 * Commands that actually execute during a design run. Everything else shapes
 * the downstream brief only.
 */
export const EVALUATE_COMMAND_IDS: readonly DesignCommandId[] = ['audit', 'critique']

export const DESIGN_COMMANDS: readonly DesignCommandDef[] = [
  // ── evaluate ───────────────────────────────────────────────────────────────
  {
    id: 'audit',
    name: 'Audit',
    category: 'evaluate',
    description:
      'Technical quality checks across accessibility, performance, theming, responsive design, and anti-patterns.',
    impeccableCommand: 'audit',
    incompatibleWith: []
  },
  {
    id: 'critique',
    name: 'Critique',
    category: 'evaluate',
    description:
      'UX evaluation of visual hierarchy, information architecture, emotional resonance, and generic-feeling design.',
    impeccableCommand: 'critique',
    incompatibleWith: []
  },

  // ── refine (amplify / visual voice) ────────────────────────────────────────
  {
    id: 'animate',
    name: 'Animate',
    category: 'refine',
    description:
      'Add purposeful animation, micro-interactions, and motion that improve feedback and continuity.',
    impeccableCommand: 'animate',
    incompatibleWith: ['distill']
  },
  {
    id: 'bolder',
    name: 'Bolder',
    category: 'refine',
    description:
      'Amplify safe or boring designs so they read as more confident and visually stimulating.',
    impeccableCommand: 'bolder',
    incompatibleWith: ['quieter', 'distill']
  },
  {
    id: 'colorize',
    name: 'Colorize',
    category: 'refine',
    description:
      'Introduce strategic color where an interface is too monochromatic or visually flat.',
    impeccableCommand: 'colorize',
    incompatibleWith: ['distill']
  },
  {
    id: 'delight',
    name: 'Delight',
    category: 'refine',
    description:
      'Add moments of joy, personality, and unexpected touches that make an interface memorable.',
    impeccableCommand: 'delight',
    incompatibleWith: ['distill']
  },
  {
    id: 'layout',
    name: 'Layout',
    category: 'refine',
    description:
      'Improve layout, spacing, and visual rhythm; fix monotonous grids and weak hierarchy.',
    impeccableCommand: 'layout',
    incompatibleWith: []
  },
  {
    id: 'quieter',
    name: 'Quieter',
    category: 'refine',
    description:
      'Tone down visually aggressive or overstimulating design while preserving quality.',
    impeccableCommand: 'quieter',
    incompatibleWith: ['bolder']
  },
  {
    id: 'typeset',
    name: 'Typeset',
    category: 'refine',
    description:
      'Fix font choices, hierarchy, sizing, weight, and readability so text feels intentional.',
    impeccableCommand: 'typeset',
    incompatibleWith: []
  },

  // ── simplify ───────────────────────────────────────────────────────────────
  {
    id: 'adapt',
    name: 'Adapt',
    category: 'simplify',
    description:
      'Adapt the design across screen sizes, devices, and platforms; breakpoints and responsive behaviour.',
    impeccableCommand: 'adapt',
    incompatibleWith: []
  },
  {
    id: 'clarify',
    name: 'Clarify',
    category: 'simplify',
    description:
      'Improve UX copy, error messages, microcopy, labels, and instructions so the interface reads clearly.',
    impeccableCommand: 'clarify',
    incompatibleWith: []
  },
  {
    id: 'distill',
    name: 'Distill',
    category: 'simplify',
    description: 'Strip the design to its essence by removing unnecessary complexity and ornament.',
    impeccableCommand: 'distill',
    incompatibleWith: ['animate', 'bolder', 'colorize', 'delight']
  },

  // ── harden (production readiness) ──────────────────────────────────────────
  {
    id: 'harden',
    name: 'Harden',
    category: 'harden',
    description:
      'Make the interface production-ready: error handling, i18n, text overflow, and edge cases.',
    impeccableCommand: 'harden',
    incompatibleWith: []
  },
  {
    id: 'onboard',
    name: 'Onboard',
    category: 'harden',
    description:
      'Design onboarding flows, first-run experiences, and empty states that guide users to value.',
    impeccableCommand: 'onboard',
    incompatibleWith: []
  },
  {
    id: 'optimize',
    name: 'Optimize',
    category: 'harden',
    description:
      'Diagnose and fix UI performance: loading, rendering, animation cost, images, and bundle size.',
    impeccableCommand: 'optimize',
    incompatibleWith: []
  },
  {
    id: 'polish',
    name: 'Polish',
    category: 'harden',
    description:
      'Final quality pass on alignment, spacing, consistency, and micro-detail before shipping.',
    impeccableCommand: 'polish',
    incompatibleWith: []
  }
] as const

/** Lookup by id. */
export const DESIGN_COMMANDS_BY_ID: Readonly<Record<string, DesignCommandDef>> = Object.fromEntries(
  DESIGN_COMMANDS.map((c) => [c.id, c])
)

export function getDesignCommand(id: string): DesignCommandDef | undefined {
  return DESIGN_COMMANDS_BY_ID[id]
}

/**
 * Design-relevant source extensions.
 *
 * Matches the file types Impeccable's detector actually reads; a scope with
 * none of these yields an `applicability: 'not-applicable'` run rather than
 * burning tokens on a backend-only workspace.
 */
export const IMPECCABLE_DESIGN_EXTENSIONS: readonly string[] = [
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.astro',
  '.mjs'
]

/** True when a path looks like something a design pass could act on. */
export function isDesignRelevantPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return IMPECCABLE_DESIGN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Prefabricated brief chips for the wizard's first step. */
export const DESIGN_BRIEF_EXAMPLES: readonly string[] = [
  'Audit the current UX and tell me what is weakest',
  'This page feels generic and AI-made',
  'I want to animate this user page',
  'Make the dashboard feel calmer and less noisy',
  'Get this screen production-ready for launch',
  'The typography and spacing feel inconsistent'
]

// ── Selection rules ──────────────────────────────────────────────────────────

/** A conflicting pair, always ordered so the same clash reports identically. */
export type DesignCommandConflict = [DesignCommandId, DesignCommandId]

export interface DesignCommandSetValidation {
  valid: boolean
  conflicts: DesignCommandConflict[]
}

/**
 * Check a selection against the incompatibility matrix.
 *
 * Each clashing pair is reported once, in catalogue order, so the UI does not
 * render "bolder ↔ quieter" and "quieter ↔ bolder" as two separate badges.
 * Unknown ids are ignored rather than rejected — the caller validates
 * membership separately and a stale id should not mask a real conflict.
 */
export function validateDesignCommandSet(ids: readonly string[]): DesignCommandSetValidation {
  const order = new Map(DESIGN_COMMANDS.map((c, i) => [c.id, i] as const))
  const selected = ids.filter((id): id is DesignCommandId => order.has(id as DesignCommandId))
  const seen = new Set<string>()
  const conflicts: DesignCommandConflict[] = []

  for (const id of selected) {
    const def = DESIGN_COMMANDS_BY_ID[id]
    if (!def) continue
    for (const other of def.incompatibleWith) {
      if (!selected.includes(other)) continue
      const pair: DesignCommandConflict =
        (order.get(id) ?? 0) <= (order.get(other) ?? 0) ? [id, other] : [other, id]
      const key = `${pair[0]}|${pair[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push(pair)
    }
  }

  return { valid: conflicts.length === 0, conflicts }
}

/** The evaluate-class commands in a selection — i.e. what will actually run. */
export function evaluateCommandsSelected(ids: readonly string[]): DesignCommandId[] {
  return DESIGN_COMMANDS.filter((c) => c.category === 'evaluate' && ids.includes(c.id)).map(
    (c) => c.id
  )
}

/** The refine-class commands in a selection — these only shape the brief. */
export function refineCommandsSelected(ids: readonly string[]): DesignCommandId[] {
  return DESIGN_COMMANDS.filter((c) => c.category !== 'evaluate' && ids.includes(c.id)).map(
    (c) => c.id
  )
}

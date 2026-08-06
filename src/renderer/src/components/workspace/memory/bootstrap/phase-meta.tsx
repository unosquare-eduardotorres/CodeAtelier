/**
 * Shared phase metadata for the Feed Brain panels.
 */

import { Zap, Search, FileText, Layers, GitBranch, Network, Sparkles, Flag } from 'lucide-react'
import type { BootstrapPhaseLabel } from '../../../../../../shared/types'

export interface PhaseInfo {
  label: string
  icon: React.ReactNode
  description: string
}

export const PHASE_INFO: Record<string, PhaseInfo> = {
  preflight: {
    label: 'Preflight',
    icon: <Zap className="w-3.5 h-3.5" />,
    description: 'Check prerequisites and plan the queue'
  },
  docs: {
    label: 'Docs',
    icon: <FileText className="w-3.5 h-3.5" />,
    description: 'Extract from documentation'
  },
  stack: {
    label: 'Stack',
    icon: <Layers className="w-3.5 h-3.5" />,
    description: 'Analyze tech stack'
  },
  architecture: {
    label: 'Architecture',
    icon: <Network className="w-3.5 h-3.5" />,
    description: 'Central files by PageRank'
  },
  history: {
    label: 'History',
    icon: <GitBranch className="w-3.5 h-3.5" />,
    description: 'Mine git history'
  },
  structure: {
    label: 'Structure',
    icon: <Search className="w-3.5 h-3.5" />,
    description: 'Detect gotchas'
  },
  'agent-exploration': {
    label: 'Agent Scan',
    icon: <Sparkles className="w-3.5 h-3.5" />,
    description: 'AI explores the codebase'
  },
  finalize: {
    label: 'Finalize',
    icon: <Flag className="w-3.5 h-3.5" />,
    description: 'Backfill embeddings & save markers'
  }
}

export const FULL_PHASES: BootstrapPhaseLabel[] = [
  'preflight',
  'docs',
  'stack',
  'architecture',
  'history',
  'structure',
  'finalize'
]

export const DEEP_SCAN_PHASES: BootstrapPhaseLabel[] = [
  'preflight',
  'docs',
  'stack',
  'architecture',
  'history',
  'agent-exploration',
  'finalize'
]

/** "2m 30s" / "45s" — null input renders as an em dash by the caller. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/** "2h ago" / "just now" */
export function formatRelative(iso: string): string {
  // SQLite datetime('now') is UTC without a zone marker; make that explicit
  // or the browser reads it as local time and reports a future timestamp.
  const normalised = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`
  const then = new Date(normalised).getTime()
  if (Number.isNaN(then)) return iso

  const diffSec = Math.max(0, (Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

/**
 * Resolve a model-supplied icon *name* to a Lucide component.
 *
 * The emit_plan tool lets the model attach an `icon` to each plan section. That
 * field is a free string, and the model supplies a Lucide id — usually
 * kebab-case ("alert-triangle"), sometimes namespaced ("lucide:list") because
 * the mermaid guidance in default-prompts.ts uses that form, and occasionally
 * already PascalCase.
 *
 * Older plans (and specialists/personas elsewhere in the app) put an emoji in
 * the same field. Those must keep rendering as text, so `looksLikeIconName`
 * separates the two cases and callers fall back to plain text for emoji.
 *
 * Lucide 1.x renamed a number of icons (AlertTriangle -> TriangleAlert,
 * CheckCircle -> CircleCheck, ...). Both spellings are still exported and
 * models tend to emit the pre-1.x names, so both are registered.
 */
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Boxes,
  Bug,
  CheckCircle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleHelp,
  ClipboardList,
  Clock,
  Code,
  Cpu,
  Database,
  Eye,
  FileCode,
  FileText,
  Files,
  Filter,
  FlaskConical,
  Flag,
  Folder,
  FolderTree,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hammer,
  HelpCircle,
  Info,
  Key,
  Layers,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListTodo,
  Lock,
  Milestone,
  Network,
  Package,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Rocket,
  Route,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Target,
  Terminal,
  TestTube,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
  Zap
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** PascalCase name -> component. Keys are matched after normalisation. */
const ICON_REGISTRY: Record<string, LucideIcon> = {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Boxes,
  Bug,
  CheckCircle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleHelp,
  ClipboardList,
  Clock,
  Code,
  Cpu,
  Database,
  Eye,
  FileCode,
  FileText,
  Files,
  Filter,
  Flag,
  FlaskConical,
  Folder,
  FolderTree,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hammer,
  HelpCircle,
  Info,
  Key,
  Layers,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListTodo,
  Lock,
  Milestone,
  Network,
  Package,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Rocket,
  Route,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Target,
  Terminal,
  TestTube,
  Timer,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
  Zap
}

/**
 * Aliases for ids that are not a pure case-conversion of a registry key, so a
 * near-miss still lands on something sensible instead of the generic fallback.
 */
const ALIASES: Record<string, string> = {
  Warning: 'TriangleAlert',
  Error: 'CircleAlert',
  Danger: 'CircleAlert',
  Success: 'CircleCheck',
  Check: 'CircleCheck',
  Done: 'CircleCheck',
  Test: 'FlaskConical',
  Tests: 'FlaskConical',
  Testing: 'FlaskConical',
  Task: 'ListChecks',
  Tasks: 'ListChecks',
  Steps: 'ListChecks',
  File: 'FileText',
  Doc: 'FileText',
  Docs: 'BookOpen',
  Documentation: 'BookOpen',
  Code2: 'Code',
  Git: 'GitBranch',
  GitCommit: 'GitCommitHorizontal',
  Security: 'Shield',
  Performance: 'Gauge',
  Risk: 'TriangleAlert',
  Risks: 'TriangleAlert',
  Goal: 'Target',
  Goals: 'Target',
  Summary: 'ClipboardList',
  Overview: 'ClipboardList',
  Plan: 'ClipboardList',
  Edit: 'SquarePen',
  Refactor: 'RefreshCw',
  Deploy: 'Rocket',
  Build: 'Hammer',
  Config: 'Settings',
  Configuration: 'Settings',
  Idea: 'Lightbulb',
  Note: 'Info',
  Notes: 'Info',
  Question: 'CircleHelp',
  Migration: 'Route',
  Dependencies: 'Boxes'
}

/**
 * Whether a string looks like an icon *identifier* rather than a literal glyph.
 *
 * Emoji and other symbol content has no ASCII letters, so requiring a leading
 * ASCII letter cleanly separates "alert-triangle" / "lucide:list" / "FileText"
 * from an emoji a previous version of the app stored in the same field.
 */
export function looksLikeIconName(raw: string): boolean {
  const value = stripNamespace(raw).trim()
  if (!value) return false
  return /^[A-Za-z][A-Za-z0-9]*([-_ ][A-Za-z0-9]+)*$/.test(value)
}

/** Drop a `lucide:` / `lucide-icons:` style namespace prefix. */
function stripNamespace(raw: string): string {
  const colon = raw.indexOf(':')
  return colon === -1 ? raw : raw.slice(colon + 1)
}

/** "alert-triangle" | "alert_triangle" | "alertTriangle" -> "AlertTriangle". */
function toPascalCase(raw: string): string {
  return stripNamespace(raw)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('')
}

/**
 * Resolve an icon name to a component, or null when the string is not a name
 * at all (an emoji) so the caller can render it as text.
 *
 * A name that IS an identifier but is unknown resolves to `fallback` rather
 * than null: rendering the raw id as text is the bug this module exists to
 * prevent.
 */
export function lucideIconByName(
  raw: string | undefined | null,
  fallback: LucideIcon = CircleDot
): LucideIcon | null {
  if (!raw) return null
  if (!looksLikeIconName(raw)) return null

  const pascal = toPascalCase(raw)
  const direct = ICON_REGISTRY[pascal]
  if (direct) return direct

  const aliased = ALIASES[pascal]
  if (aliased && ICON_REGISTRY[aliased]) return ICON_REGISTRY[aliased]

  return fallback
}

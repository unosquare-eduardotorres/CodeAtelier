/**
 * skillIcons — Maps skill names/keywords to appropriate Lucide icon names.
 *
 * Returns the Lucide icon component name for a given skill, enabling
 * visually distinct skill cards in the Skill Market grid.
 */

import type { LucideIcon } from 'lucide-react'
import {
  Monitor,
  Database,
  TestTubes,
  FlaskConical,
  Shield,
  GitBranch,
  Layout,
  Palette,
  Brush,
  Image,
  Presentation,
  FileText,
  Wrench,
  Code2,
  Cpu,
  Cloud,
  Blocks,
  BookOpen,
  PenTool,
  Rocket,
  Workflow,
  Bot,
  Puzzle,
  Server,
  Landmark
} from 'lucide-react'

/**
 * Map of skill name patterns → Lucide icon components.
 * Checked in order — first match wins.
 */
const SKILL_ICON_RULES: Array<{ pattern: RegExp; icon: LucideIcon }> = [
  // Electron / desktop
  { pattern: /electron/i, icon: Monitor },
  // Database / SQLite / Supabase
  { pattern: /sqlite|database|supabase/i, icon: Database },
  // Testing — Playwright gets a distinct icon from general testing
  { pattern: /playwright|e2e/i, icon: FlaskConical },
  { pattern: /test/i, icon: TestTubes },
  // Security
  { pattern: /security|auth/i, icon: Shield },
  // Git / version control
  { pattern: /git/i, icon: GitBranch },
  // IPC / patterns
  { pattern: /ipc|pattern/i, icon: Workflow },
  // Claude / AI / agent
  { pattern: /claude|agent|sdk/i, icon: Bot },
  // Architecture / architect
  { pattern: /architect/i, icon: Landmark },
  // UI / UX
  { pattern: /ui|ux/i, icon: Layout },
  // Design system / tokens
  { pattern: /design.system|token/i, icon: Blocks },
  // Design (general)
  { pattern: /design(?!.*doc)/i, icon: Palette },
  // Design docs
  { pattern: /design.doc/i, icon: FileText },
  // Brand
  { pattern: /brand/i, icon: Brush },
  // Banner
  { pattern: /banner/i, icon: Image },
  // Slides / presentations
  { pattern: /slide|presentation/i, icon: Presentation },
  // Mermaid / diagrams
  { pattern: /mermaid|diagram/i, icon: PenTool },
  // Documentation
  { pattern: /doc/i, icon: BookOpen },
  // Planner
  { pattern: /plan/i, icon: Puzzle },
  // Infrastructure / CI-CD / deploy
  { pattern: /infra|ci.?cd|deploy|container|docker|terraform/i, icon: Cloud },
  // .NET / dotnet
  { pattern: /dotnet|\.net|csharp/i, icon: Server },
  // General dev
  { pattern: /general|dev/i, icon: Wrench },
  // Build / compile
  { pattern: /build|compile/i, icon: Rocket },
  // Code
  { pattern: /code/i, icon: Code2 },
  // CPU / performance
  { pattern: /perf|optim/i, icon: Cpu }
]

/**
 * Returns the appropriate Lucide icon component for a skill name.
 * Falls back to Code2 (generic code icon) for unrecognized skills.
 */
export function getSkillIcon(skillName: string): LucideIcon {
  for (const rule of SKILL_ICON_RULES) {
    if (rule.pattern.test(skillName)) {
      return rule.icon
    }
  }
  return Code2
}

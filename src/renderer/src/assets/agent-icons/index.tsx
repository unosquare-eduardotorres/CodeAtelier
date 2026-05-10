/**
 * Code Atelier Agent Icons — SVG line-art in Renaissance etching style
 * Each icon: 24x24 viewBox, stroke-width 1.2, fill none, stroke currentColor
 * Color is inherited from parent CSS `color` property
 */

import ReactArchitectSvg from './react-architect.svg?raw'
import DotnetArchitectSvg from './dotnet-architect.svg?raw'
import AgenticArchitectSvg from './agentic-architect.svg?raw'
import PostgresArchitectSvg from './postgres-architect.svg?raw'
import UxUiSpecialistSvg from './ux-ui-specialist.svg?raw'
import GitSpecialistSvg from './git-specialist.svg?raw'
import RequirementsSpecialistSvg from './requirements-specialist.svg?raw'
import CodePlannerSvg from './code-planner.svg?raw'
import ExecutionPlannerSvg from './execution-planner.svg?raw'
import CicdSpecialistSvg from './cicd-specialist.svg?raw'
import CloudSpecialistSvg from './cloud-specialist.svg?raw'
import GeneralistSvg from './generalist.svg?raw'
import DocsSpecialistSvg from './docs-specialist.svg?raw'

interface AgentIconProps {
  size?: number
  className?: string
}

function SvgIcon({
  svg,
  size = 24,
  className
}: AgentIconProps & { svg: string }): React.JSX.Element {
  return (
    <span
      className={className}
      style={{ width: size, height: size, display: 'inline-flex' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/**
 * Map of agent type slugs to their SVG icon components.
 * Agent types match the slugs used in the database and agent registry.
 */
// eslint-disable-next-line react-refresh/only-export-components -- intentional co-located constant export with component
export const AGENT_ICON_MAP: Record<string, string> = {
  'react-architect': ReactArchitectSvg,
  'dotnet-architect': DotnetArchitectSvg,
  'agentic-architect': AgenticArchitectSvg,
  'db-architect': PostgresArchitectSvg,
  'postgres-architect': PostgresArchitectSvg,
  'ux-ui-specialist': UxUiSpecialistSvg,
  'git-github-specialist': GitSpecialistSvg,
  'git-specialist': GitSpecialistSvg,
  'requirements-specialist': RequirementsSpecialistSvg,
  'code-planner': CodePlannerSvg,
  'execution-planner': ExecutionPlannerSvg,
  'cicd-devops': CicdSpecialistSvg,
  'cicd-specialist': CicdSpecialistSvg,
  'cloud-infra': CloudSpecialistSvg,
  'cloud-specialist': CloudSpecialistSvg,
  generalist: GeneralistSvg,
  'generalist-developer': GeneralistSvg,
  'docs-diagrams-specialist': DocsSpecialistSvg,
  'docs-specialist': DocsSpecialistSvg
}

/**
 * Render an agent icon by agent type slug.
 * Falls back to the generalist icon if the type is not recognized.
 */
export function AgentIcon({
  agentType,
  size = 24,
  className
}: AgentIconProps & { agentType: string }): React.JSX.Element {
  const svg = AGENT_ICON_MAP[agentType] ?? GeneralistSvg
  return <SvgIcon svg={svg} size={size} className={className} />
}

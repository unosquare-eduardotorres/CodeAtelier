/**
 * AdvisorIcon — maps CouncilAdvisorDefinition.icon strings to Lucide components.
 */

import { ShieldAlert, Microscope, Rocket, Eye, Zap, User } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { CouncilAdvisorDefinition } from '../../../../../shared/constants'

const ICON_MAP: Record<string, React.ComponentType<LucideProps>> = {
  ShieldAlert,
  Microscope,
  Rocket,
  Eye,
  Zap
}

interface AdvisorIconProps extends LucideProps {
  advisor: CouncilAdvisorDefinition | undefined
}

export default function AdvisorIcon({ advisor, ...props }: AdvisorIconProps): React.JSX.Element {
  const IconComponent = advisor ? (ICON_MAP[advisor.icon] ?? User) : User
  return <IconComponent {...props} />
}

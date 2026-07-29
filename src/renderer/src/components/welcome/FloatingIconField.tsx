import { Code2, Terminal, GitBranch, Cpu, Braces, Database, Layers, Rocket } from 'lucide-react'
import Avatar from '@renderer/components/common/Avatar'

interface FloatingItem {
  id: string
  type: 'icon' | 'avatar'
  // Icon items
  Icon?: React.ComponentType<{ size: number; className?: string }>
  colorClass?: string
  // Avatar items
  avatarKey?: string
  // Position & animation
  top: string
  left: string
  size: number
  opacity: number
  duration: string
  delay: string
  floatDistance: string
  rotateStart: string
  rotateEnd: string
  driftX: string
  animation: 'float-bounce' | 'float-drift'
}

const FLOATING_ITEMS: FloatingItem[] = [
  // Lucide icons — scattered across the viewport (bold opacity for home page presence)
  {
    id: 'code',
    type: 'icon',
    Icon: Code2,
    colorClass: 'text-primary-text',
    top: '8%',
    left: '12%',
    size: 32,
    opacity: 0.35,
    duration: '7s',
    delay: '0s',
    floatDistance: '-22px',
    rotateStart: '-5deg',
    rotateEnd: '10deg',
    driftX: '12px',
    animation: 'float-drift'
  },
  {
    id: 'terminal',
    type: 'icon',
    Icon: Terminal,
    colorClass: 'text-accent',
    top: '15%',
    left: '78%',
    size: 28,
    opacity: 0.3,
    duration: '5.5s',
    delay: '-1.5s',
    floatDistance: '-18px',
    rotateStart: '3deg',
    rotateEnd: '-8deg',
    driftX: '-9px',
    animation: 'float-bounce'
  },
  {
    id: 'git',
    type: 'icon',
    Icon: GitBranch,
    colorClass: 'text-success',
    top: '35%',
    left: '5%',
    size: 26,
    opacity: 0.28,
    duration: '6.5s',
    delay: '-3s',
    floatDistance: '-16px',
    rotateStart: '-10deg',
    rotateEnd: '5deg',
    driftX: '14px',
    animation: 'float-drift'
  },
  {
    id: 'cpu',
    type: 'icon',
    Icon: Cpu,
    colorClass: 'text-primary-text',
    top: '55%',
    left: '88%',
    size: 30,
    opacity: 0.32,
    duration: '8s',
    delay: '-2s',
    floatDistance: '-20px',
    rotateStart: '8deg',
    rotateEnd: '-6deg',
    driftX: '-8px',
    animation: 'float-bounce'
  },
  {
    id: 'braces',
    type: 'icon',
    Icon: Braces,
    colorClass: 'text-accent',
    top: '70%',
    left: '15%',
    size: 24,
    opacity: 0.25,
    duration: '6s',
    delay: '-4s',
    floatDistance: '-14px',
    rotateStart: '-3deg',
    rotateEnd: '12deg',
    driftX: '10px',
    animation: 'float-drift'
  },
  {
    id: 'db',
    type: 'icon',
    Icon: Database,
    colorClass: 'text-warning',
    top: '80%',
    left: '82%',
    size: 26,
    opacity: 0.3,
    duration: '7.5s',
    delay: '-1s',
    floatDistance: '-17px',
    rotateStart: '6deg',
    rotateEnd: '-4deg',
    driftX: '-11px',
    animation: 'float-bounce'
  },
  {
    id: 'layers',
    type: 'icon',
    Icon: Layers,
    colorClass: 'text-primary-text',
    top: '25%',
    left: '92%',
    size: 24,
    opacity: 0.25,
    duration: '5s',
    delay: '-2.5s',
    floatDistance: '-15px',
    rotateStart: '-7deg',
    rotateEnd: '7deg',
    driftX: '8px',
    animation: 'float-drift'
  },
  {
    id: 'rocket',
    type: 'icon',
    Icon: Rocket,
    colorClass: 'text-danger',
    top: '45%',
    left: '3%',
    size: 28,
    opacity: 0.33,
    duration: '6.8s',
    delay: '-3.5s',
    floatDistance: '-19px',
    rotateStart: '10deg',
    rotateEnd: '-5deg',
    driftX: '-9px',
    animation: 'float-bounce'
  },

  // Mini avatars — colorful characters floating in the background
  {
    id: 'av-alchemist',
    type: 'avatar',
    avatarKey: 'mannequin-main',
    top: '20%',
    left: '45%',
    size: 32,
    opacity: 0.4,
    duration: '8.5s',
    delay: '-1s',
    floatDistance: '-20px',
    rotateStart: '-4deg',
    rotateEnd: '4deg',
    driftX: '10px',
    animation: 'float-drift'
  },
  {
    id: 'av-knight',
    type: 'avatar',
    avatarKey: 'da-vinci',
    top: '60%',
    left: '55%',
    size: 28,
    opacity: 0.35,
    duration: '7s',
    delay: '-3s',
    floatDistance: '-16px',
    rotateStart: '5deg',
    rotateEnd: '-5deg',
    driftX: '-10px',
    animation: 'float-bounce'
  },
  {
    id: 'av-astronomer',
    type: 'avatar',
    avatarKey: 'atelier-auditor',
    top: '42%',
    left: '22%',
    size: 30,
    opacity: 0.38,
    duration: '6.2s',
    delay: '-2s',
    floatDistance: '-18px',
    rotateStart: '-6deg',
    rotateEnd: '8deg',
    driftX: '12px',
    animation: 'float-drift'
  },
  {
    id: 'av-navigator',
    type: 'avatar',
    avatarKey: 'grillme',
    top: '75%',
    left: '40%',
    size: 28,
    opacity: 0.3,
    duration: '7.8s',
    delay: '-4.5s',
    floatDistance: '-17px',
    rotateStart: '3deg',
    rotateEnd: '-7deg',
    driftX: '-8px',
    animation: 'float-bounce'
  }
]

/**
 * Atmospheric floating icon field for the WelcomeScreen background.
 * Renders development-themed icons and mini-avatars that gently bounce and drift.
 *
 * Accessibility: Fully decorative (aria-hidden), respects prefers-reduced-motion
 * via the global CSS rule that kills animation-duration.
 */
export default function FloatingIconField(): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none select-none"
      aria-hidden="true"
    >
      {FLOATING_ITEMS.map((item) => (
        <div
          key={item.id}
          className="absolute"
          style={
            {
              top: item.top,
              left: item.left,
              opacity: item.opacity,
              animation: `${item.animation} ${item.duration} ease-in-out infinite`,
              animationDelay: item.delay,
              '--float-distance': item.floatDistance,
              '--float-rotate-start': item.rotateStart,
              '--float-rotate-end': item.rotateEnd,
              '--drift-x': item.driftX
            } as React.CSSProperties
          }
        >
          {item.type === 'icon' && item.Icon ? (
            <item.Icon size={item.size} className={item.colorClass} />
          ) : item.type === 'avatar' && item.avatarKey ? (
            <Avatar avatarKey={item.avatarKey} size="sm" />
          ) : null}
        </div>
      ))}
    </div>
  )
}

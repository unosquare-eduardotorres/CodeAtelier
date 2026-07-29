import { useRef, useEffect } from 'react'
import type { TransitionPhase, AnimationType } from './useTransitionState'
import { GlassPanelsAnimation } from './GlassPanelsAnimation'
import { GoldParticleAnimation } from './GoldParticleAnimation'

interface WorkspaceTransitionProps {
  phase: TransitionPhase
  animationType: AnimationType
  workspaceName: string | null
  onAnimationComplete: () => void
  onAnimationError: () => void
}

export function WorkspaceTransition({
  phase,
  animationType,
  workspaceName,
  onAnimationComplete,
  onAnimationError,
}: WorkspaceTransitionProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<GlassPanelsAnimation | GoldParticleAnimation | null>(null)

  // Mount/unmount Three.js animation
  useEffect(() => {
    if (phase !== 'animating' || !containerRef.current) return

    const container = containerRef.current

    if (animationType === 'glass') {
      animationRef.current = new GlassPanelsAnimation({
        container,
        onComplete: onAnimationComplete,
        onError: onAnimationError,
      })
    } else if (animationType === 'particle') {
      animationRef.current = new GoldParticleAnimation({
        container,
        workspaceName: workspaceName ?? 'Workspace',
        onComplete: onAnimationComplete,
        onError: onAnimationError,
      })
    }

    return () => {
      // Strict disposal on unmount (handles interruptions)
      animationRef.current?.dispose()
      animationRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, animationType, workspaceName, onAnimationComplete, onAnimationError])

  // Dispose when entering disposing phase
  useEffect(() => {
    if (phase === 'disposing') {
      animationRef.current?.dispose()
      animationRef.current = null
    }
  }, [phase])

  // Auto-complete fade animation after CSS transition.
  // Uses onAnimationError (→ forceComplete) to bypass TRANSITION_MIN_DURATION.
  // The 200ms CSS opacity transition is the only visual effect — holding an 800ms
  // minimum would leave a solid black overlay long after the fade finishes.
  useEffect(() => {
    if (phase !== 'animating' || animationType !== 'fade') return
    const timer = setTimeout(onAnimationError, 250) // 200ms transition + 50ms buffer
    return () => clearTimeout(timer)
  }, [phase, animationType, onAnimationError])

  if (phase !== 'animating' && phase !== 'disposing') return null

  // CSS fade fallback for reduced-motion
  if (animationType === 'fade') {
    return (
      <div
        className="fixed inset-0 z-50 transition-opacity duration-200"
        style={{
          opacity: phase === 'disposing' ? 0 : 1,
          background: '#010208',
        }}
        data-testid="workspace-transition-overlay"
      />
    )
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50"
      style={{ background: '#010208', overflow: 'hidden' }} // bg matches scene to prevent flash between animations
      aria-hidden="true"
      data-testid="workspace-transition-overlay"
    />
  )
}

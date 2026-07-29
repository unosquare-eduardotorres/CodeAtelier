import { useState, useRef, useEffect, useCallback } from 'react'
import { prefersReducedMotion, isE2ETesting, hasSeenTransition, markTransitionSeen } from './transition-utils'
import { TRANSITION_MIN_DURATION, TRANSITION_MAX_DURATION } from './transition-constants'

export type TransitionPhase = 'idle' | 'animating' | 'disposing' | 'complete'
export type AnimationType = 'glass' | 'particle' | 'fade' | 'none'

interface TransitionState {
  phase: TransitionPhase
  animationType: AnimationType
  workspaceId: string | null
  workspaceName: string | null
}

interface UseTransitionStateReturn {
  state: TransitionState
  shouldShowOverlay: boolean
  startTransition: (workspaceId: string, workspaceName: string) => void
  completeAnimation: () => void
  forceComplete: () => void
}

export function useTransitionState(): UseTransitionStateReturn {
  const [state, setState] = useState<TransitionState>({
    phase: 'idle',
    workspaceId: null,
    workspaceName: null,
    animationType: 'none',
  })

  const startTimeRef = useRef<number>(0)
  const minTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startTransition = useCallback((workspaceId: string, workspaceName: string) => {
    // Determine animation type
    let animationType: AnimationType = 'none'

    if (isE2ETesting()) {
      animationType = 'none'
    } else if (prefersReducedMotion()) {
      animationType = 'fade'
    } else if (!hasSeenTransition(workspaceId)) {
      animationType = 'particle'
      markTransitionSeen(workspaceId)
    } else {
      animationType = 'glass'
    }

    if (animationType === 'none') {
      setState({ phase: 'complete', workspaceId, workspaceName, animationType })
      return
    }

    startTimeRef.current = performance.now()
    setState({
      phase: 'animating',
      workspaceId,
      workspaceName,
      animationType,
    })
  }, [])

  // Animation complete → move to disposing phase
  const completeAnimation = useCallback(() => {
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    const elapsed = performance.now() - startTimeRef.current
    const remaining = Math.max(0, TRANSITION_MIN_DURATION - elapsed)

    // Respect minimum duration
    if (remaining > 0) {
      minTimerRef.current = setTimeout(() => {
        setState((s) => (s.phase === 'animating' ? { ...s, phase: 'disposing' } : s))
      }, remaining)
    } else {
      setState((s) => (s.phase === 'animating' ? { ...s, phase: 'disposing' } : s))
    }
  }, [])

  // Force-complete (interrupt, error, context lost)
  const forceComplete = useCallback(() => {
    if (minTimerRef.current) clearTimeout(minTimerRef.current)
    setState((s) => {
      if (s.phase === 'idle' || s.phase === 'complete') return s
      return { ...s, phase: 'disposing' }
    })
  }, [])

  // disposing → complete (after cleanup, fires on next frame)
  useEffect(() => {
    if (state.phase === 'disposing') {
      const id = requestAnimationFrame(() => {
        setState((s) => ({ ...s, phase: 'complete' }))
      })
      return () => cancelAnimationFrame(id)
    }
  }, [state.phase])

  // Hard cap: never exceed max duration
  useEffect(() => {
    if (state.phase === 'animating') {
      const timer = setTimeout(() => {
        completeAnimation()
      }, TRANSITION_MAX_DURATION)
      return () => clearTimeout(timer)
    }
  }, [state.phase, completeAnimation])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (minTimerRef.current) clearTimeout(minTimerRef.current)
    }
  }, [])

  const shouldShowOverlay = state.phase === 'animating' || state.phase === 'disposing'

  return { state, shouldShowOverlay, startTransition, completeAnimation, forceComplete }
}

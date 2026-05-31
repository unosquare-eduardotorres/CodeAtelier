/**
 * useSpecialistWarningFlow — Block-send → show-dialog → confirm-or-cancel flow.
 *
 * Extracted from MessageInput to isolate the specialist warning intercept (~50 LOC).
 *
 * When sending a message, this hook checks whether the user should be warned
 * about active specialist token overhead. If a warning applies, the send is
 * blocked, the message is stashed in `pendingSend`, and a confirmation dialog
 * is shown. On confirm, the stashed message is forwarded to `executeSend`.
 */

import { useState, useCallback } from 'react'
import type { SpecialistWarningType } from '../SpecialistWarningDialog'

interface Conversation {
  mode?: string
  [key: string]: unknown
}

interface UseSpecialistWarningFlowOptions {
  activeConversation: Conversation | null
  activeSpecialistCount: number
  specialistWarningAlways: boolean
  specialistWarningBuild: boolean
  specialistWarningPlan: boolean
  executeSend: (content: string, attachments?: string[]) => Promise<void>
}

interface UseSpecialistWarningFlowResult {
  /** Check if a warning should block this send. Returns true if blocked. */
  checkWarning: (content: string, attachments?: string[]) => boolean
  showSpecialistWarning: boolean
  specialistWarningType: SpecialistWarningType
  /** Cancel the warning dialog and discard the pending send. */
  cancelWarning: () => void
  /** Confirm the warning and forward the stashed message to executeSend. */
  confirmWarning: () => void
}

export function useSpecialistWarningFlow(
  opts: UseSpecialistWarningFlowOptions
): UseSpecialistWarningFlowResult {
  const [showSpecialistWarning, setShowSpecialistWarning] = useState(false)
  const [specialistWarningType, setSpecialistWarningType] =
    useState<SpecialistWarningType>('always')
  const [pendingSend, setPendingSend] = useState<{
    content: string
    attachments?: string[]
  } | null>(null)

  const getWarningType = useCallback((): SpecialistWarningType | null => {
    if (!opts.activeConversation || opts.activeSpecialistCount === 0) return null
    if (opts.specialistWarningAlways) return 'always'
    if (opts.activeConversation.mode === 'build' && opts.specialistWarningBuild) return 'build'
    if (opts.activeConversation.mode === 'plan' && opts.specialistWarningPlan) return 'plan'
    return null
  }, [
    opts.activeConversation,
    opts.activeSpecialistCount,
    opts.specialistWarningAlways,
    opts.specialistWarningBuild,
    opts.specialistWarningPlan
  ])

  const checkWarning = useCallback(
    (content: string, attachments?: string[]): boolean => {
      const warningType = getWarningType()
      if (!warningType) return false

      setSpecialistWarningType(warningType)
      setPendingSend({ content, attachments })
      setShowSpecialistWarning(true)
      return true
    },
    [getWarningType]
  )

  const cancelWarning = useCallback(() => {
    setShowSpecialistWarning(false)
    setPendingSend(null)
  }, [])

  const confirmWarning = useCallback(() => {
    const pending = pendingSend
    setShowSpecialistWarning(false)
    setPendingSend(null)
    if (pending) {
      void opts.executeSend(pending.content, pending.attachments)
    }
  }, [pendingSend, opts.executeSend])

  return {
    checkWarning,
    showSpecialistWarning,
    specialistWarningType,
    cancelWarning,
    confirmWarning
  }
}

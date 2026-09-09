/**
 * useDangerModeGuard — confirmation gate for entering Danger mode.
 *
 * Plan→Build cycles freely, but Build→Danger drops a conversation into
 * "every command executes without checks" — one accidental ⌘. double-press
 * (or pill click) must not get there silently. The guard intercepts the
 * transition, shows a danger ConfirmDialog, and applies the mode only on
 * explicit confirmation.
 */

import { useCallback, useState } from 'react'
import type { ConversationMode } from '../../../shared/types'
import ConfirmDialog from '@renderer/components/common/ConfirmDialog'

export function useDangerModeGuard(applyMode: (mode: ConversationMode) => void): {
  guardedModeChange: (mode: ConversationMode) => void
  guardDialog: React.JSX.Element | null
} {
  const [confirmingDanger, setConfirmingDanger] = useState(false)

  const guardedModeChange = useCallback(
    (mode: ConversationMode) => {
      if (mode !== 'danger') {
        applyMode(mode)
        return
      }
      setConfirmingDanger(true)
    },
    [applyMode]
  )

  const guardDialog = confirmingDanger ? (
    <ConfirmDialog
      isOpen
      variant="danger"
      title="Enter Danger Mode?"
      message="In Danger mode every command executes immediately — no checks, no confirmations, no safety gates. Only continue if you fully trust this task."
      confirmLabel="Enter Danger Mode"
      onConfirm={() => {
        setConfirmingDanger(false)
        applyMode('danger')
      }}
      onCancel={() => setConfirmingDanger(false)}
    />
  ) : null

  return { guardedModeChange, guardDialog }
}

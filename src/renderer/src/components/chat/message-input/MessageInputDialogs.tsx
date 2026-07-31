import { ConfirmDialog } from '@renderer/components/common'
import CompleteDialog from '../CompleteDialog'
import CloseDialog from '../CloseDialog'
import RewindDialog from '../RewindDialog'
import SpecialistWarningDialog, { type SpecialistWarningType } from '../SpecialistWarningDialog'

interface MessageInputDialogsProps {
  // Stop confirm
  showStopConfirm: boolean
  onStopConfirm: () => Promise<void>
  onStopCancel: () => void
  // Complete dialog
  showCompleteDialog: boolean
  conversationTitle: string
  conversationId: string
  onCompleteConfirm: (
    branchName: string,
    commitMessage: string,
    description: string,
    baseBranch?: string
  ) => Promise<void>
  onCompleteClose: () => Promise<void>
  onCompleteCancel: () => void
  // Close confirm
  showCloseConfirm: boolean
  onCloseConfirm: () => Promise<void>
  onCloseCancel: () => void
  // Rewind dialog
  showRewindDialog: boolean
  onRewindCancel: () => void
  onRewindComplete: () => void
  // Specialist warning
  showSpecialistWarning: boolean
  specialistWarningType: SpecialistWarningType
  activeSpecialistCount: number
  estimatedSpecialistTokens: number
  onSpecialistWarningCancel: () => void
  onSpecialistWarningConfirm: () => void
}

export default function MessageInputDialogs({
  showStopConfirm,
  onStopConfirm,
  onStopCancel,
  showCompleteDialog,
  conversationTitle,
  conversationId,
  onCompleteConfirm,
  onCompleteClose,
  onCompleteCancel,
  showCloseConfirm,
  onCloseConfirm,
  onCloseCancel,
  showRewindDialog,
  onRewindCancel,
  onRewindComplete,
  showSpecialistWarning,
  specialistWarningType,
  activeSpecialistCount,
  estimatedSpecialistTokens,
  onSpecialistWarningCancel,
  onSpecialistWarningConfirm
}: MessageInputDialogsProps): React.JSX.Element {
  return (
    <div data-testid="message-input-dialogs">
      <div data-testid="stop-confirm-dialog">
        <ConfirmDialog
          isOpen={showStopConfirm}
          title="Stop Generation"
          message="Are you sure you want to stop the current response? The AI will stop generating immediately."
          confirmLabel="Stop"
          cancelLabel="Continue"
          variant="danger"
          onConfirm={onStopConfirm}
          onCancel={onStopCancel}
        />
      </div>

      <CompleteDialog
        isOpen={showCompleteDialog}
        conversationTitle={conversationTitle}
        conversationId={conversationId}
        onConfirm={onCompleteConfirm}
        onClose={onCompleteClose}
        onCancel={onCompleteCancel}
      />

      <CloseDialog
        isOpen={showCloseConfirm}
        conversationId={conversationId}
        onConfirm={onCloseConfirm}
        onCancel={onCloseCancel}
      />

      <RewindDialog
        isOpen={showRewindDialog}
        conversationId={conversationId}
        onCancel={onRewindCancel}
        onComplete={onRewindComplete}
      />

      <SpecialistWarningDialog
        isOpen={showSpecialistWarning}
        warningType={specialistWarningType}
        activeSpecialistCount={activeSpecialistCount}
        estimatedTokens={estimatedSpecialistTokens}
        onCancel={onSpecialistWarningCancel}
        onConfirm={onSpecialistWarningConfirm}
      />
    </div>
  )
}

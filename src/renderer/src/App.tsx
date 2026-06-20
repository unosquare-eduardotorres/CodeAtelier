import { useCallback } from 'react'
import { useBugCapture } from '@renderer/hooks/useBugCapture'
import { AppLayout } from '@renderer/components/layout'
import {
  WelcomeModal,
  CheckpointApprovalModal,
  ElicitationModal,
  UpdateAvailableModal
} from '@renderer/components/common'
import { useProfileStore } from '@renderer/store'
import { useTheme } from '@renderer/hooks/useTheme'
import { useAppIpcListeners } from '@renderer/hooks/useAppIpcListeners'

function App(): React.JSX.Element {
  // Apply active theme (data-theme attribute on <html>)
  useTheme()

  // Global error capture → bug tracker
  useBugCapture()

  // IPC event listeners (streaming, agent status, auto-update, etc.)
  useAppIpcListeners()

  // Profile state + actions
  const isProfileLoading = useProfileStore((s) => s.isLoading)
  const hasCompletedWelcome = useProfileStore((s) => s.hasCompletedWelcome)
  const saveProfile = useProfileStore((s) => s.saveProfile)

  const handleWelcomeComplete = useCallback(
    async (displayName: string, avatarKey: string) => {
      await saveProfile(displayName, avatarKey)
    },
    [saveProfile]
  )

  // Brief loading state while profile loads
  if (isProfileLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-base">
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 border border-primary/30 rounded animate-pulse"
            style={{ transform: 'rotate(45deg)' }}
          >
            <div className="w-full h-full border border-primary/10 rounded m-0.5" />
          </div>
          <span className="text-sm text-text-muted tracking-widest">Loading...</span>
        </div>
      </div>
    )
  }

  // Show welcome modal on first launch
  if (!hasCompletedWelcome) {
    return <WelcomeModal onComplete={handleWelcomeComplete} />
  }

  return (
    <>
      <AppLayout />
      <CheckpointApprovalModal />
      <ElicitationModal />
      <UpdateAvailableModal />
    </>
  )
}

export default App

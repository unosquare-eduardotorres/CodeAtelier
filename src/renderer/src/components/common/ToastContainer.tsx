import { useToastStore } from '@renderer/store/toast.store'
import Toast from './Toast'

interface ToastContainerProps {
  onNavigate?: (target: string) => void
}

export default function ToastContainer({ onNavigate }: ToastContainerProps): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return <></>

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={removeToast} onNavigate={onNavigate} />
      ))}
    </div>
  )
}

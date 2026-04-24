import { useEffect, useState } from 'react'
import { X, Bug, Info, CheckCircle, AlertCircle } from 'lucide-react'
import type { Toast as ToastType } from '@renderer/store/toast.store'

interface ToastProps {
  toast: ToastType
  onDismiss: (id: string) => void
  onNavigate?: (target: string) => void
}

const iconMap = {
  bug: Bug,
  info: Info,
  success: CheckCircle,
  error: AlertCircle
} as const

const colorMap = {
  bug: 'text-orange-400',
  info: 'text-blue-400',
  success: 'text-emerald-400',
  error: 'text-red-400'
} as const

export default function Toast({ toast, onDismiss, onNavigate }: ToastProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false)
  const Icon = iconMap[toast.type]

  useEffect(() => {
    // Trigger slide-in animation
    requestAnimationFrame(() => setIsVisible(true))
  }, [])

  const handleClick = (): void => {
    if (toast.onClickNavigate && onNavigate) {
      onNavigate(toast.onClickNavigate)
      onDismiss(toast.id)
    }
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-surface-elevated border border-border-subtle rounded-lg shadow-lg max-w-sm transition-all duration-300 ease-out ${
        isVisible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
      } ${toast.onClickNavigate ? 'cursor-pointer hover:bg-surface-overlay' : ''}`}
      onClick={handleClick}
      role="alert"
      aria-live="polite"
    >
      <Icon size={18} className={colorMap[toast.type]} />
      <span className="flex-1 text-sm text-text-primary">{toast.message}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDismiss(toast.id)
        }}
        className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

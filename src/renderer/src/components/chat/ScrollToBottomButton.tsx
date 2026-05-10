import { ArrowDown } from 'lucide-react'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
}

export default function ScrollToBottomButton({
  visible,
  onClick
}: ScrollToBottomButtonProps): React.JSX.Element | null {
  if (!visible) return null

  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 right-6 z-20 flex items-center justify-center
        w-9 h-9 rounded-full bg-surface-overlay border border-border-subtle
        shadow-lg hover:bg-surface-raised transition-all duration-200
        text-text-secondary hover:text-text-primary
        animate-in fade-in slide-in-from-bottom-2"
      aria-label="Scroll to latest message"
    >
      <ArrowDown size={18} />
    </button>
  )
}

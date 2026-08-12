import { ArrowDown } from 'lucide-react'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
  ariaLabel?: string
}

export default function ScrollToBottomButton({
  visible,
  onClick,
  ariaLabel = 'Scroll to bottom'
}: ScrollToBottomButtonProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`absolute bottom-4 right-6 z-20 flex items-center justify-center
        w-9 h-9 rounded-full bg-primary-base border border-primary-muted
        shadow-lg shadow-primary-base/20 hover:bg-primary-hover
        text-white
        transition-all duration-200
        ${
          visible
            ? 'opacity-100 translate-y-0 pointer-events-auto animate-pulse'
            : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
      aria-label={ariaLabel}
      data-testid="scroll-to-bottom"
      tabIndex={visible ? 0 : -1}
    >
      <ArrowDown size={18} />
    </button>
  )
}

interface ChatTabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  badge?: number | null
}

export default function ChatTabButton({
  active,
  onClick,
  children,
  badge
}: ChatTabButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
        transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 outline-none
        ${
          active
            ? 'bg-surface-overlay text-text-primary shadow-sm border border-border-default'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50'
        }
      `}
      role="tab"
      aria-selected={active}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold bg-primary-muted text-primary-text">
          {badge}
        </span>
      )}
    </button>
  )
}

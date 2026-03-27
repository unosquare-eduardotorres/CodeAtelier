/**
 * Skeleton — lightweight shimmer placeholder for loading states.
 * Use `skeleton-shimmer` class for the animated gradient effect,
 * or plain `animate-pulse` for a simpler pulse.
 */
export default function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div className={`skeleton-shimmer rounded ${className ?? ''}`} />
}

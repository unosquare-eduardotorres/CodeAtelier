interface SettingsCardProps {
  children: React.ReactNode
  className?: string
}

/**
 * Shared card wrapper for all settings tab sections.
 * Ensures consistent border-radius, shadow, border, and background across all settings pages.
 */
export default function SettingsCard({
  children,
  className = ''
}: SettingsCardProps): React.JSX.Element {
  return (
    <div
      className={`bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm ${className}`}
    >
      {children}
    </div>
  )
}

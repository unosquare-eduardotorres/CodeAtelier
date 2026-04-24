import { Check } from 'lucide-react'
import type { Specialist } from '../../../../shared/types'

interface PersonaCardProps {
  specialist: Specialist
  /** Show "Default" badge (for Da Vinci) */
  isDefault?: boolean
  selected: boolean
  /** Grayed out for inactive specialists */
  disabled?: boolean
  onSelect: () => void
}

export default function PersonaCard({
  specialist,
  isDefault,
  selected,
  disabled,
  onSelect
}: PersonaCardProps): React.JSX.Element {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`
        relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all
        w-[140px] h-[160px] text-center
        focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none
        ${
          selected
            ? 'border-primary bg-primary/10 shadow-md shadow-primary/10'
            : disabled
              ? 'border-border-subtle bg-surface-overlay/40 opacity-50 cursor-not-allowed'
              : 'border-border-subtle bg-surface-overlay hover:border-primary/40 hover:bg-surface-float cursor-pointer press-scale'
        }
      `}
      aria-pressed={selected}
      aria-label={`Select ${specialist.alias ?? specialist.displayName} as persona${disabled ? ' (inactive)' : ''}`}
    >
      {/* Selection indicator */}
      {selected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
          <Check size={12} className="text-white" strokeWidth={3} />
        </div>
      )}

      {/* Avatar */}
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center ${
          selected ? 'ring-2 ring-primary/30' : ''
        }`}
        style={{ backgroundColor: `${specialist.color}20` }}
      >
        <span className="text-2xl">{specialist.icon}</span>
      </div>

      {/* Name */}
      <div className="w-full">
        <p className="text-xs font-semibold text-text-primary leading-tight break-words line-clamp-2">
          {specialist.alias ?? specialist.displayName}
        </p>
        {specialist.alias && (
          <p className="text-[10px] text-text-muted truncate">{specialist.displayName}</p>
        )}
      </div>

      {/* Badges */}
      <div className="flex gap-1">
        {isDefault && (
          <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
            Default
          </span>
        )}
        {disabled && (
          <span className="text-[10px] font-medium text-text-muted bg-surface-raised px-1.5 py-0.5 rounded-full">
            Inactive
          </span>
        )}
      </div>
    </button>
  )
}

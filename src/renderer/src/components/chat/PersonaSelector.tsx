import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useSpecialistStore, useChatActions } from '@renderer/store'
import type { Conversation, Specialist } from '../../../../shared/types'

interface PersonaSelectorProps {
  conversation: Conversation
}

export default function PersonaSelector({ conversation }: PersonaSelectorProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const specialists = useSpecialistStore((s) => s.specialists)
  const { switchPersona } = useChatActions()

  // Resolve current persona
  const currentPersona = useMemo(() => {
    if (conversation.personaSpecialistId) {
      return specialists.find((s) => s.id === conversation.personaSpecialistId) ?? null
    }
    return specialists.find((s) => s.agentId === 'da-vinci') ?? null
  }, [conversation.personaSpecialistId, specialists])

  const isDaVinci = !conversation.personaSpecialistId

  // Categorize for dropdown
  const { daVinci, activeItems, inactiveItems } = useMemo(() => {
    const dv = specialists.find((s) => s.agentId === 'da-vinci')
    const active = specialists
      .filter((s) => !s.isCore && s.isActive)
      .sort((a, b) => a.priority - b.priority)
    const inactive = specialists
      .filter((s) => !s.isCore && !s.isActive)
      .sort((a, b) => a.priority - b.priority)
    return { daVinci: dv, activeItems: active, inactiveItems: inactive }
  }, [specialists])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleSelect = (specialistId: string | null): void => {
    setOpen(false)
    void switchPersona(specialistId)
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-surface-overlay transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Current persona: ${currentPersona?.alias ?? currentPersona?.displayName ?? 'Da Vinci'}`}
      >
        {/* Mini avatar */}
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${currentPersona?.color ?? '#6366F1'}20` }}
        >
          <span className="text-xs">{currentPersona?.icon ?? '🎨'}</span>
        </div>
        <span className="text-xs font-medium text-text-primary max-w-[100px] truncate">
          {currentPersona?.alias ?? currentPersona?.displayName ?? 'Da Vinci'}
        </span>
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-56 bg-surface-float border border-border-default rounded-xl shadow-xl z-50 py-1 max-h-80 overflow-y-auto animate-in fade-in zoom-in-95"
          role="listbox"
          aria-label="Select persona"
        >
          <div className="px-3 py-1.5">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
              Persona
            </span>
          </div>

          {/* Da Vinci option */}
          {daVinci && (
            <DropdownItem
              specialist={daVinci}
              selected={isDaVinci}
              badge="Default"
              onClick={() => handleSelect(null)}
            />
          )}

          {/* Active specialists */}
          {activeItems.length > 0 && (
            <>
              <div className="mx-3 my-1 border-t border-border-subtle" />
              {activeItems.map((s) => (
                <DropdownItem
                  key={s.id}
                  specialist={s}
                  selected={conversation.personaSpecialistId === s.id}
                  onClick={() => handleSelect(s.id)}
                />
              ))}
            </>
          )}

          {/* Inactive specialists */}
          {inactiveItems.length > 0 && (
            <>
              <div className="mx-3 my-1 border-t border-border-subtle" />
              <div className="px-3 py-1">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  Inactive
                </span>
              </div>
              {inactiveItems.map((s) => (
                <DropdownItem
                  key={s.id}
                  specialist={s}
                  selected={false}
                  disabled
                  onClick={() => {
                    /* disabled */
                  }}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DropdownItem({
  specialist,
  selected,
  disabled,
  badge,
  onClick
}: {
  specialist: Specialist
  selected: boolean
  disabled?: boolean
  badge?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="option"
      aria-selected={selected}
      className={`
        w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
        ${
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : selected
              ? 'bg-primary/10'
              : 'hover:bg-surface-overlay'
        }
      `}
    >
      {/* Avatar */}
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${specialist.color}20` }}
      >
        <span className="text-sm">{specialist.icon}</span>
      </div>

      {/* Name + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text-primary truncate">
            {specialist.alias ?? specialist.displayName}
          </span>
          {badge && (
            <span className="text-[9px] font-medium text-primary bg-primary/10 px-1 py-0.5 rounded-full flex-shrink-0">
              {badge}
            </span>
          )}
        </div>
        {specialist.description && (
          <p className="text-[10px] text-text-muted truncate">{specialist.description}</p>
        )}
      </div>

      {/* Check */}
      {selected && <Check size={14} className="text-primary flex-shrink-0" />}
    </button>
  )
}

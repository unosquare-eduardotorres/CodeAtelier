import type { LucideIcon } from 'lucide-react'

interface SlashCommand {
  command: string
  description: string
  icon: LucideIcon
  iconColor: string
}

interface SlashCommandDropdownProps {
  commands: SlashCommand[]
  selectedIndex: number
  onSelect: (command: string) => void
}

export default function SlashCommandDropdown({
  commands,
  selectedIndex,
  onSelect
}: SlashCommandDropdownProps): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-1 left-0 bg-surface-float rounded-lg border border-border-default py-1.5 w-[30rem] shadow-xl z-50">
      {commands.map((cmd, index) => {
        const Icon = cmd.icon
        return (
          <button
            key={cmd.command}
            onClick={() => onSelect(cmd.command)}
            className={`w-full text-left px-4 py-2 text-base transition-colors flex items-center gap-3 ${
              index === selectedIndex
                ? 'bg-surface-overlay text-text-primary'
                : 'hover:bg-surface-overlay/50 text-text-body'
            }`}
          >
            <Icon size={18} className={`${cmd.iconColor} flex-shrink-0`} />
            <span className="text-primary-text font-mono text-sm font-medium w-28 flex-shrink-0">
              {cmd.command}
            </span>
            <span className="text-text-secondary text-sm">{cmd.description}</span>
          </button>
        )
      })}
    </div>
  )
}

import { ClipboardList, Hammer } from 'lucide-react';
import type { ConversationMode } from '../../../../shared/types';

interface ModeToggleProps {
  mode: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  disabled?: boolean;
}

export default function ModeToggle({ mode, onChange, disabled }: ModeToggleProps): React.JSX.Element {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const shortcut = isMac ? '⌘.' : 'Ctrl+.';

  return (
    <div
      className="flex items-center gap-1.5 bg-gray-800 rounded-lg p-0.5 border border-gray-700/50"
      title={`Toggle mode (${shortcut})`}
    >
      <button
        onClick={() => onChange('plan')}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
          mode === 'plan'
            ? 'bg-purple-600/30 text-purple-300 border border-purple-500/30'
            : 'text-gray-400 hover:text-gray-200'
        }`}
      >
        <ClipboardList size={12} />
        Plan
      </button>
      <button
        onClick={() => onChange('build')}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
          mode === 'build'
            ? 'bg-amber-600/30 text-amber-300 border border-amber-500/30'
            : 'text-gray-400 hover:text-gray-200'
        }`}
      >
        <Hammer size={12} />
        Build
      </button>
      <span className="text-[10px] text-gray-500 px-1 font-mono">{shortcut}</span>
    </div>
  );
}

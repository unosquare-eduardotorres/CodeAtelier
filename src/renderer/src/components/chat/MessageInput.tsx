import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Send, Square, Minimize2, Trash2, HelpCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useChatStore, useWorkspaceStore } from '@renderer/store';
import { ConfirmDialog } from '@renderer/components/common';

interface MessageInputProps {
  attachments: string[];
  onClearAttachments: () => void;
}

const SLASH_COMMANDS: Array<{
  command: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
}> = [
  { command: '/compact', description: 'Compress conversation context to save tokens', icon: Minimize2, iconColor: 'text-amber-400' },
  { command: '/clear', description: 'Clear chat display (keeps AI context)', icon: Trash2, iconColor: 'text-red-400' },
  { command: '/help', description: 'Show available commands', icon: HelpCircle, iconColor: 'text-blue-400' }
];

export default function MessageInput({ attachments, onClearAttachments }: MessageInputProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, isStreaming, activeConversation, stopGeneration, clearDisplay, appendLocalMessage } = useChatStore();
  const { orchestratorStatus } = useWorkspaceStore();
  const isInitializing = orchestratorStatus === 'starting';

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = 6 * 24; // ~6 lines
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // Slash command filtering
  const filteredCommands = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const typed = text.split(' ')[0].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(typed));
  }, [text]);

  const showCommands = text.startsWith('/') && filteredCommands.length > 0;

  // Reset selected index when filtered commands change
  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [filteredCommands.length]);

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || !activeConversation) return;

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      const cmd = trimmed.split(' ')[0].toLowerCase();

      if (cmd === '/compact') {
        setText('');
        // Send /compact through the normal message flow — the AI understands it
        // and the IPC handler will also trigger the compact() method
        await sendMessage(trimmed, attachments.length > 0 ? attachments : undefined);
        onClearAttachments();
        return;
      }

      if (cmd === '/clear') {
        setText('');
        // Clear messages display but keep the AI process running with context
        clearDisplay();
        return;
      }

      if (cmd === '/help') {
        setText('');
        const helpLines = [
          '🗜️ **/compact** — Compress conversation context to save tokens',
          '🗑️ **/clear** — Clear chat display (keeps AI context)',
          '❓ **/help** — Show available commands'
        ];
        appendLocalMessage(`### Available Commands\n\n${helpLines.join('\n')}`);
        return;
      }
    }

    setText('');
    await sendMessage(trimmed, attachments.length > 0 ? attachments : undefined);
    onClearAttachments();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Handle command autocomplete navigation
    if (showCommands) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredCommands[selectedCommandIndex];
        if (selected) {
          setText(selected.command);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isDisabled = isStreaming || !activeConversation || isInitializing;

  return (
    <>
      <div className="relative flex-1 min-w-0 flex items-end gap-2">
        {/* Slash command autocomplete dropdown */}
        {showCommands && (
          <div className="absolute bottom-full mb-1 left-0 bg-gray-800 rounded-lg border border-gray-700 py-1 w-72 shadow-xl z-50">
            {filteredCommands.map((cmd, index) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.command}
                  onClick={() => {
                    setText(cmd.command);
                    textareaRef.current?.focus();
                  }}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2.5 ${
                    index === selectedCommandIndex
                      ? 'bg-gray-700 text-white'
                      : 'hover:bg-gray-700/50 text-gray-300'
                  }`}
                >
                  <Icon size={14} className={cmd.iconColor} />
                  <span className="text-indigo-400 font-mono">{cmd.command}</span>
                  <span className="text-gray-400 ml-auto text-xs">{cmd.description}</span>
                </button>
              );
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isInitializing
              ? 'Waiting for AI agent to initialize...'
              : !activeConversation
                ? 'Select or create a conversation...'
                : activeConversation.mode === 'plan'
                  ? 'Ask anything — type / for commands...'
                  : 'Describe what to build — type / for commands...'
          }
          disabled={isDisabled}
          rows={1}
          className="flex-1 bg-transparent text-gray-200 placeholder-gray-500 resize-none outline-none text-sm leading-relaxed py-2 disabled:opacity-50"
          aria-label="Message input"
        />

        {/* Stop button — visible when streaming */}
        {isStreaming && (
          <button
            onClick={() => setShowStopConfirm(true)}
            className="flex-shrink-0 p-2 rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
            aria-label="Stop generation"
            title="Stop generation"
          >
            <Square size={18} />
          </button>
        )}

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={isDisabled || !text.trim()}
          className="flex-shrink-0 p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 disabled:hover:bg-indigo-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900"
          aria-label="Send message (Enter)"
          title="Send message (Enter)"
        >
          <Send size={18} />
        </button>
      </div>

      <ConfirmDialog
        isOpen={showStopConfirm}
        title="Stop Generation"
        message="Are you sure you want to stop the current response? The AI will stop generating immediately."
        confirmLabel="Stop"
        cancelLabel="Continue"
        variant="danger"
        onConfirm={async () => {
          await stopGeneration();
          setShowStopConfirm(false);
        }}
        onCancel={() => setShowStopConfirm(false)}
      />
    </>
  );
}

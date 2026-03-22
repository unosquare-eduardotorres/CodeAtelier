import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { useChatStore, useWorkspaceStore } from '@renderer/store';
import { ConfirmDialog } from '@renderer/components/common';

interface MessageInputProps {
  attachments: string[];
}

export default function MessageInput({ attachments }: MessageInputProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, isStreaming, activeConversation, stopGeneration } = useChatStore();
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

  const handleSend = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || !activeConversation) return;

    setText('');
    await sendMessage(trimmed, attachments.length > 0 ? attachments : undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isDisabled = isStreaming || !activeConversation || isInitializing;

  return (
    <>
      <div className="flex-1 min-w-0 flex items-end gap-2">
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
                  ? 'Ask anything — analyze code, brainstorm ideas, create plans...'
                  : 'Describe what to build or change...'
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

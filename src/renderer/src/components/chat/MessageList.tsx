import { useChatStore } from '@renderer/store';
import { useAutoScroll } from '@renderer/hooks';
import { MessageBubble, HandoffIndicator } from '@renderer/components/chat';
import FloatingRobots from './FloatingRobots';

interface MessageListProps {
  searchQuery?: string;
}

export default function MessageList({ searchQuery }: MessageListProps): React.JSX.Element {
  const { messages, streamingContent, streamingRole, isStreaming, activeHandoff, toolActivities } = useChatStore();
  const scrollRef = useAutoScroll([messages.length, streamingContent]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="relative flex-1 flex flex-col items-center justify-center text-center px-8">
        <FloatingRobots />
        <span className="relative z-10 text-4xl mb-4">💬</span>
        <h3 className="relative z-10 text-lg font-medium text-gray-400 mb-2">
          Start a conversation
        </h3>
        <p className="relative z-10 text-sm text-gray-600 max-w-md">
          Chat with your AI development partner. Ask questions, brainstorm ideas, review code, or describe what you want built — the generalist will handle it or hand off to specialists.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
    <FloatingRobots />
    <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-6 py-4 space-y-4 h-full">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} searchHighlight={searchQuery} />
      ))}

      {/* Handoff indicator — shown when generalist triggers a handoff */}
      {activeHandoff && (
        <HandoffIndicator
          summary={activeHandoff.summary}
          specialists={activeHandoff.specialists}
          mode={activeHandoff.mode}
        />
      )}

      {/* Thinking indicator: shows when streaming but no content yet */}
      {isStreaming && !streamingContent && (
        <div className="flex justify-start">
          <div className="flex flex-col gap-2 px-4 py-3 rounded-xl bg-gray-800/50 border border-gray-700/50">
            <div className="flex items-center gap-2">
              <svg
                className="animate-spin h-4 w-4 text-indigo-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm text-gray-400">
                {activeHandoff ? 'Working on it...' : 'Thinking...'}
              </span>
            </div>
            {toolActivities.length > 0 && (
              <div className="space-y-1 border-l-2 border-gray-700 pl-3 ml-1">
                {toolActivities.slice(-5).map((activity) => (
                  <div key={activity.id} className="flex items-center gap-2 text-xs">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        activity.status === 'running'
                          ? 'bg-yellow-400 animate-pulse'
                          : activity.status === 'completed'
                            ? 'bg-green-400'
                            : 'bg-red-400'
                      }`}
                    />
                    <span className="font-mono text-gray-300">{activity.toolName}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Streaming message bubble */}
      {isStreaming && streamingContent && (
        <MessageBubble
          message={{
            id: 'streaming',
            conversationId: '',
            role: streamingRole,
            contentMd: streamingContent,
            attachmentsJson: '[]',
            createdAt: new Date().toISOString()
          }}
          isStreaming
          toolActivities={toolActivities}
        />
      )}
    </div>
    </div>
  );
}

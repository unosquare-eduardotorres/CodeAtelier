import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Copy, Check, MessageCircle, Wrench, Paperclip } from 'lucide-react';
import type { Message, ToolActivity } from '../../../../shared/types';
import PlanCard from './PlanCard';
import ToolActivityBlock from './ToolActivityBlock';
import { useChatStore } from '@renderer/store';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  searchHighlight?: string;
  toolActivities?: ToolActivity[];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  // Extract language and code text from children
  const codeChild = React.Children.toArray(children).find(
    (child): child is React.ReactElement => React.isValidElement(child) && (child as React.ReactElement).type === 'code'
  );

  const className = (codeChild?.props as { className?: string })?.className || '';
  const language = className.replace('language-', '');
  const codeText = String((codeChild?.props as { children?: React.ReactNode })?.children || '').replace(/\n$/, '');

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      console.error('Failed to copy to clipboard');
    }
  }, [codeText]);

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden border border-gray-700/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-gray-700/50">
        <span className="text-xs text-gray-400 font-mono">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-700/50"
          aria-label={copied ? 'Copied!' : 'Copy code'}
          title={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check size={12} className="text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="bg-gray-950 p-3 overflow-x-auto text-sm whitespace-pre-wrap break-words">{children}</pre>
    </div>
  );
}

const avatarConfig: Record<string, { icon: React.ReactNode; bg: string; label: string }> = {
  user:        { icon: <User size={16} className="text-white" />, bg: 'bg-indigo-600', label: 'You' },
  generalist:  { icon: <MessageCircle size={16} className="text-emerald-300" />, bg: 'bg-emerald-600', label: 'Generalist' },
  coordinator: { icon: <Bot size={16} className="text-indigo-400" />, bg: 'bg-gray-700', label: 'Coordinator' },
  specialist:  { icon: <Wrench size={16} className="text-amber-300" />, bg: 'bg-amber-600', label: 'Specialist' },
};

export default function MessageBubble({
  message,
  isStreaming,
  toolActivities
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user';
  const { updateMode, sendMessage } = useChatStore();
  const avatar = avatarConfig[message.role] ?? avatarConfig.coordinator;

  // Parse attachments from JSON
  const attachments: string[] = (() => {
    try {
      const parsed = JSON.parse(message.attachmentsJson || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const imageAttachments = attachments.filter((p) => /\.(png|jpg|jpeg|gif|webp)$/i.test(p));
  const fileAttachments = attachments.filter((p) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(p));

  // Detect plan blocks in coordinator/generalist messages
  const planRegex = /```plan\n([\s\S]*?)```/;
  const planMatch = !isUser ? message.contentMd.match(planRegex) : null;

  const handleBuild = (): void => {
    updateMode('build');
    sendMessage('Implement the plan we just discussed. Follow the steps exactly.');
  };

  const handleRefine = (feedback: string): void => {
    sendMessage(`Please refine the plan: ${feedback}`);
  };

  // Split content around plan block if found
  const beforePlan = planMatch ? message.contentMd.substring(0, planMatch.index!) : null;
  const afterPlan = planMatch ? message.contentMd.substring(planMatch.index! + planMatch[0].length) : null;
  const planContent = planMatch ? planMatch[1] : null;

  const markdownComponents = {
    pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
      const isBlock = className?.includes('language-');
      if (isBlock) {
        return <code className={`${className} text-sm`}>{children}</code>;
      }

      // Check if the code content is a URL — render as clickable link
      const text = String(children).trim();
      const isUrl = /^https?:\/\/\S+$/.test(text);
      if (isUrl) {
        return (
          <a
            href={text}
            className="bg-gray-700/50 px-1.5 py-0.5 rounded text-sm text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              if (text) window.open(text, '_blank');
            }}
          >
            {children}
          </a>
        );
      }

      return (
        <code className="bg-gray-700/50 px-1.5 py-0.5 rounded text-sm text-indigo-300">
          {children}
        </code>
      );
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a
        href={href}
        className="text-indigo-400 hover:text-indigo-300 underline"
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          if (href) window.open(href, '_blank');
        }}
      >
        {children}
      </a>
    )
  };

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${avatar.bg}`}
      >
        {avatar.icon}
      </div>

      {/* Content */}
      <div className={`flex flex-col ${isUser ? 'max-w-[75%] items-end' : 'max-w-[85%] items-start'}`}>
        <span className="text-[11px] text-gray-400 mb-1 px-1">
          {avatar.label}
        </span>

        {planContent ? (
          /* Message with a plan block — split into before/plan/after */
          <div className="space-y-3 max-w-full">
            {beforePlan?.trim() && (
              <div className={`rounded-2xl px-4 py-3 bg-gray-800 text-gray-200 border border-gray-700/50`}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {beforePlan}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            <PlanCard planContent={planContent} onBuild={handleBuild} onRefine={handleRefine} />
            {afterPlan?.trim() && (
              <div className={`rounded-2xl px-4 py-3 bg-gray-800 text-gray-200 border border-gray-700/50`}>
                <div className="prose max-w-none prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {afterPlan}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : (
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? 'bg-indigo-600 text-white'
              : 'bg-gray-800 text-gray-200 border border-gray-700/50'
          }`}
        >
          {/* Image attachments */}
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {imageAttachments.map((path, idx) => (
                <img
                  key={idx}
                  src={`file://${path}`}
                  alt={path.split('/').pop() || 'attachment'}
                  className="max-w-[240px] max-h-[180px] rounded-lg border border-gray-600/50 object-contain cursor-pointer hover:border-indigo-500/50 transition-colors"
                  onClick={() => window.open(`file://${path}`, '_blank')}
                />
              ))}
            </div>
          )}

          {/* File attachments */}
          {fileAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {fileAttachments.map((path, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-700/50 text-xs text-gray-400"
                >
                  <Paperclip size={10} />
                  {path.split('/').pop() || path}
                </span>
              ))}
            </div>
          )}

          {message.contentMd ? (
            <div className={`prose max-w-none ${isUser ? 'prose-invert' : 'prose-invert'}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {message.contentMd}
              </ReactMarkdown>
            </div>
          ) : isStreaming ? (
            <div className="flex items-center gap-1.5 py-1">
              <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" />
            </div>
          ) : null}
        </div>
        )}

        {/* Inline tool activity block */}
        {toolActivities && toolActivities.length > 0 && (
          <ToolActivityBlock activities={toolActivities} />
        )}

        <span className="text-[11px] text-gray-500 mt-1 px-1">
          {formatTime(message.createdAt)}
          {isStreaming && ' · Streaming...'}
        </span>
      </div>
    </div>
  );
}

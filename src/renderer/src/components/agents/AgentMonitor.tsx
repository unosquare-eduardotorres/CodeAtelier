import { useEffect } from 'react';
import { Monitor, ChevronLeft, ChevronRight, OctagonX } from 'lucide-react';
import { useAgentStore, useSpecialistStore } from '@renderer/store';
import { AgentStatusCard } from '@renderer/components/agents';

interface AgentMonitorProps {
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function AgentMonitor({
  isCollapsed,
  onToggleCollapse
}: AgentMonitorProps): React.JSX.Element {
  const { statuses, stopAllAgents, isStopping } = useAgentStore();
  const { specialists, loadSpecialists } = useSpecialistStore();

  // Load specialists on mount so AgentStatusCard can read metadata from DB
  useEffect(() => {
    if (specialists.length === 0) {
      loadSpecialists();
    }
  }, [specialists.length, loadSpecialists]);

  // Filter: only show agents that are active or have been used (have tokens)
  const visibleStatuses = statuses.filter(
    (s) => s.status !== 'idle' || s.tokenUsage > 0
  );

  const activeCount = statuses.filter(
    (s) => s.status === 'thinking' || s.status === 'writing' || s.status === 'reviewing'
  ).length;

  // Collapsed state: slim bar
  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 bg-gray-900 border-l border-gray-700 flex-shrink-0">
        {/* Header area — matches sidebar header height for continuous border line */}
        <div className="flex items-center justify-center w-full py-3 border-b border-gray-700">
          <button
            onClick={onToggleCollapse}
            className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Expand agent panel"
            title="Expand agent panel"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
        <div className="flex flex-col items-center gap-2 py-3">
        <Monitor size={16} className="text-indigo-400" />
        {activeCount > 0 && (
          <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-600 text-[10px] font-semibold text-white">
            {activeCount}
          </span>
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 border-l border-gray-700 w-[350px] flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-gray-200">Agent Monitor</span>
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-600 text-[10px] font-semibold text-white">
              {activeCount}
            </span>
          )}
          {visibleStatuses.length > 0 && (
            <button
              onClick={stopAllAgents}
              disabled={isStopping}
              className="p-1.5 rounded-md hover:bg-red-900/40 text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Stop all agents"
              title="Stop all agents"
            >
              <OctagonX size={16} className={isStopping ? 'animate-pulse' : ''} />
            </button>
          )}
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Collapse agent panel"
            title="Collapse agent panel"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {visibleStatuses.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Monitor size={32} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No agents active</p>
            <p className="text-xs text-gray-600">
              Agents will appear here when processing tasks
            </p>
          </div>
        ) : (
          visibleStatuses.map((status) => <AgentStatusCard key={status.agentId} status={status} />)
        )}
      </div>
    </div>
  );
}

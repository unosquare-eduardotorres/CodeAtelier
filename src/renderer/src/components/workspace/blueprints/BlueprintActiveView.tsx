import type { JSX } from 'react'
import {
  BlueprintPhaseTimeline,
  BlueprintPhaseStream,
  BlueprintApprovalGate,
  BlueprintWaveProgress
} from '.'
import type { BlueprintPageState } from './useBlueprintPageState'

type ActiveViewProps = Pick<
  BlueprintPageState,
  | 'pendingApproval'
  | 'currentPhase'
  | 'phaseStartedAt'
  | 'displayedPhase'
  | 'displayedStreamText'
  | 'isViewingLivePhase'
  | 'currentBlueprint'
  | 'currentWave'
  | 'waveTasks'
  | 'waveTaskDescriptions'
  | 'workspaceId'
  | 'clarifyMessages'
  | 'clarifyWaitingForInput'
  | 'handleApprove'
  | 'handleReject'
  | 'handleCancel'
  | 'setSelectedPhase'
  | 'sendClarifyAnswer'
  | 'skipClarify'
>

export default function BlueprintActiveView({
  pendingApproval,
  currentPhase,
  phaseStartedAt,
  displayedPhase,
  displayedStreamText,
  isViewingLivePhase,
  currentBlueprint,
  currentWave,
  waveTasks,
  waveTaskDescriptions,
  workspaceId,
  clarifyMessages,
  clarifyWaitingForInput,
  handleApprove,
  handleReject,
  handleCancel,
  setSelectedPhase,
  sendClarifyAnswer,
  skipClarify
}: ActiveViewProps): JSX.Element {
  return (
    <div data-testid="blueprint-active-view" className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Approval Gate overlay */}
      {pendingApproval && (
        <div className="bg-surface-raised rounded-xl border border-emerald-400/30 p-4">
          <BlueprintApprovalGate
            planSummary={pendingApproval.planSummary}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
          />
        </div>
      )}

      {/* Timeline + Stream */}
      <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="flex flex-1 min-h-0 divide-x divide-border-subtle">
          {/* Timeline sidebar */}
          <div className="w-[180px] flex-shrink-0 p-4 overflow-y-auto">
            <BlueprintPhaseTimeline
              currentPhase={currentPhase}
              awaitingApproval={!!pendingApproval}
              phaseStartedAt={phaseStartedAt}
              selectedPhase={displayedPhase}
              onPhaseClick={setSelectedPhase}
            />
          </div>

          {/* Stream output */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {displayedPhase ? (
              <BlueprintPhaseStream
                phaseType={displayedPhase}
                streamText={displayedStreamText}
                isLive={isViewingLivePhase}
                blueprintTitle={currentBlueprint?.title}
                elapsed={undefined}
                clarifyMessages={displayedPhase === 'clarify' ? clarifyMessages : []}
                onClarifyAnswer={
                  currentBlueprint
                    ? (msg) => sendClarifyAnswer(currentBlueprint.id, workspaceId, msg)
                    : undefined
                }
                onSkipClarify={
                  currentBlueprint ? () => skipClarify(currentBlueprint.id) : undefined
                }
                currentPhase={currentPhase}
                clarifyWaitingForInput={clarifyWaitingForInput}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-text-muted text-xs">
                Waiting for pipeline to start...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Wave Progress — shown during build phase */}
      {currentPhase === 'build' && currentWave && (
        <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 flex-shrink-0">
          <BlueprintWaveProgress
            wave={currentWave.wave}
            taskCount={currentWave.taskCount}
            waveTasks={waveTasks}
            taskDescriptions={waveTaskDescriptions}
          />
        </div>
      )}
    </div>
  )
}

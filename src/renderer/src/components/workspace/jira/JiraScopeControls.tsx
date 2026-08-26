import type { JiraBoard, JiraProject, JiraSprint } from '../../../../../shared/jira.types'

const SELECT_CLASS =
  'bg-surface-overlay border border-border-default rounded px-1.5 py-1 text-[11px] text-text-primary max-w-[200px]'

/**
 * Server-side scoping: project, then board, then sprint.
 *
 * There is deliberately one project control rather than a REST picker *and*
 * client-side project chips — two controls that look identical and mean
 * different things is worse than one. "Group by project" covers the visual
 * split; this one changes the query.
 *
 * Board and sprint render only when the Agile API answered with something. It
 * 404s on Jira Core and 403s on some Data Center deployments, and the service
 * turns both into an empty list — a licence the workspace does not have is not
 * an error the user can act on.
 */
export default function JiraScopeControls({
  projects,
  projectKey,
  onProjectChange,
  boards,
  boardId,
  onBoardChange,
  sprints,
  sprintId,
  onSprintChange
}: {
  projects: JiraProject[]
  projectKey: string | null
  onProjectChange: (key: string | null) => void
  boards: JiraBoard[]
  boardId: number | null
  onBoardChange: (id: number | null) => void
  sprints: JiraSprint[]
  sprintId: number | null
  onSprintChange: (id: number | null) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="jira-scope-controls">
      <label className="flex items-center gap-1 text-[11px] text-text-muted">
        Project
        <select
          aria-label="Project"
          data-testid="jira-project-select"
          value={projectKey ?? ''}
          onChange={(e) => onProjectChange(e.target.value === '' ? null : e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.key} value={project.key}>
              {project.key} — {project.name}
            </option>
          ))}
        </select>
      </label>

      {boards.length > 0 && (
        <label className="flex items-center gap-1 text-[11px] text-text-muted">
          Board
          <select
            aria-label="Board"
            data-testid="jira-board-select"
            value={boardId ?? ''}
            onChange={(e) => onBoardChange(e.target.value === '' ? null : Number(e.target.value))}
            className={SELECT_CLASS}
          >
            <option value="">All boards</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {sprints.length > 0 && (
        <label className="flex items-center gap-1 text-[11px] text-text-muted">
          Sprint
          <select
            aria-label="Sprint"
            data-testid="jira-sprint-select"
            value={sprintId ?? ''}
            onChange={(e) => onSprintChange(e.target.value === '' ? null : Number(e.target.value))}
            className={SELECT_CLASS}
          >
            <option value="">Any sprint</option>
            {sprints.map((sprint) => (
              <option key={sprint.id} value={sprint.id}>
                {sprint.name}
                {sprint.state ? ` (${sprint.state})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

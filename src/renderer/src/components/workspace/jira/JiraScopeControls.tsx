import { SelectMenu } from '@renderer/components/common/ui'
import type { JiraBoard, JiraProject, JiraSprint } from '../../../../../shared/jira.types'

/** `''` is the "no scope" option — SelectMenu values are strings. */
const ANY = ''

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
      <SelectMenu
        label="Project"
        ariaLabel="Project"
        testId="jira-project-select"
        value={projectKey ?? ANY}
        options={[
          { value: ANY, label: 'All projects' },
          ...projects.map((project) => ({
            value: project.key,
            label: `${project.key} — ${project.name}`
          }))
        ]}
        onChange={(key) => onProjectChange(key === ANY ? null : key)}
      />

      {boards.length > 0 && (
        <SelectMenu
          label="Board"
          ariaLabel="Board"
          testId="jira-board-select"
          value={boardId === null ? ANY : String(boardId)}
          options={[
            { value: ANY, label: 'All boards' },
            ...boards.map((board) => ({ value: String(board.id), label: board.name }))
          ]}
          onChange={(id) => onBoardChange(id === ANY ? null : Number(id))}
        />
      )}

      {sprints.length > 0 && (
        <SelectMenu
          label="Sprint"
          ariaLabel="Sprint"
          testId="jira-sprint-select"
          value={sprintId === null ? ANY : String(sprintId)}
          options={[
            { value: ANY, label: 'Any sprint' },
            ...sprints.map((sprint) => ({
              value: String(sprint.id),
              label: `${sprint.name}${sprint.state ? ` (${sprint.state})` : ''}`
            }))
          ]}
          onChange={(id) => onSprintChange(id === ANY ? null : Number(id))}
        />
      )}
    </div>
  )
}

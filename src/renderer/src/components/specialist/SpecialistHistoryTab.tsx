import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'

interface Props {
  specialist: ProjectSpecialist
}

export default function SpecialistHistoryTab({ specialist }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold mb-1">Build status</h3>
        <div className="text-slate-600 dark:text-slate-300">{specialist.buildStatus}</div>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-1">Last built</h3>
        <div className="text-slate-600 dark:text-slate-300">
          {specialist.lastBuiltAt
            ? new Date(specialist.lastBuiltAt).toLocaleString()
            : 'Not built yet'}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-1">Detected stack</h3>
        <div className="flex flex-wrap gap-1">
          {specialist.detectedTechs.length === 0 ? (
            <span className="text-xs text-slate-500">(none)</span>
          ) : (
            specialist.detectedTechs.map((t) => (
              <span
                key={t}
                className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {t}
              </span>
            ))
          )}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-1">Stack fingerprint</h3>
        <code className="font-mono text-xs text-slate-500 dark:text-slate-400">
          {specialist.stackFingerprint ?? '(none)'}
        </code>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-1">Identifiers</h3>
        <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
          <div>id: {specialist.id}</div>
          <div>agentId: {specialist.agentId}</div>
        </div>
      </div>
    </div>
  )
}

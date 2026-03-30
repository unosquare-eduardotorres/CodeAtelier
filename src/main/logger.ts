import log from 'electron-log/main'

// ── Configure log file behavior ──
log.transports.file.maxSize = 5 * 1024 * 1024 // 5 MB per log file
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

// ── Catch unhandled errors at process level ──
log.errorHandler.startCatching({
  showDialog: false,
  onError({ error }) {
    log.error('Unhandled error:', error)
    return null
  }
})

// ── Create scoped loggers (replace LOG_PREFIX pattern) ──
export const mainLogger = log.scope('Main')
export const dbLogger = log.scope('DB')
export const generalistLogger = log.scope('Generalist')
export const chatIpcLogger = log.scope('ChatIPC')
export const agentIpcLogger = log.scope('AgentIPC')
export const skillLogger = log.scope('Skill')
export const deployLogger = log.scope('Deploy')
export const specialistPoolLogger = log.scope('SpecialistPool')
export const gitWorktreeLogger = log.scope('GitWorktree')
export const brainFeedLogger = log.scope('BrainFeed')
export const promptBuilderLogger = log.scope('PromptBuilder')
export const agentRegistryLogger = log.scope('AgentRegistry')
export const hookRunnerLogger = log.scope('HookRunner')
export const eventLoggerLogger = log.scope('EventLogger')
export const costTrackerLogger = log.scope('CostTracker')
export const checkpointLogger = log.scope('Checkpoint')

export default log

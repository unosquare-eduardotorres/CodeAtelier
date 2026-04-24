import log from 'electron-log/main'

/** Shared scoped logger for all sdk-executor modules */
export const sdkLog = log.scope('SDKExecutor')

export { HeartbeatMonitor } from './heartbeat-monitor'
export { TokenAccountant } from './token-accountant'
export type { TokenUsage } from './token-accountant'
export { TelemetryRecorder } from './telemetry-recorder'
export type { TelemetryEntry } from './telemetry-recorder'
export { ToolTracker } from './tool-tracker'
export { normalizeMessage } from './stream-normalizer'
export type { StreamState } from './stream-normalizer'

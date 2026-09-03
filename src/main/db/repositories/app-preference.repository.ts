import { BaseRepository } from '../base-repository'
import type {
  AppPreferences,
  AppTheme,
  UpdateSourceProvider,
  UserAvatarVariant
} from '../../../shared/types'

interface AppPreferenceRow {
  key: string
  value: string
  updated_at: string
}

export class AppPreferenceRepository extends BaseRepository<
  AppPreferenceRow,
  { key: string; value: string }
> {
  protected readonly tableName = 'app_preferences'
  protected mapRow(row: AppPreferenceRow): { key: string; value: string } {
    return { key: row.key, value: row.value }
  }

  get(key: string): string | null {
    const db = this.db()
    const row = db.prepare('SELECT value FROM app_preferences WHERE key = ?').get(key) as
      AppPreferenceRow | undefined
    return row ? row.value : null
  }

  set(key: string, value: string): void {
    const db = this.db()
    db.prepare(
      `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value)
  }

  getBool(key: string, defaultVal = false): boolean {
    const value = this.get(key)
    if (value === null) return defaultVal
    return value === 'true'
  }

  /** Read an integer preference, clamped to [min, max]. */
  getInt(key: string, defaultVal: number, min: number, max: number): number {
    const raw = this.get(key)
    if (raw === null) return defaultVal
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) return defaultVal
    return Math.max(min, Math.min(max, n))
  }

  /** Get all preferences as typed AppPreferences object */
  getAppPreferences(): AppPreferences {
    return {
      specialistWarningBuild: this.getBool('specialist_warning_build', true),
      specialistWarningPlan: this.getBool('specialist_warning_plan', true),
      specialistWarningAlways: this.getBool('specialist_warning_always', false),
      chatBubbleSize: (this.get('chat_bubble_size') as AppPreferences['chatBubbleSize']) ?? 'xl',
      appTheme: (this.get('app_theme') as AppTheme) ?? 'code-atelier',
      updateSource: (this.get('update_source') as UpdateSourceProvider) ?? 'drive',
      updateDrivePath: this.get('update_drive_path') ?? '',
      updateGithubOwner: this.get('update_github_owner') ?? '',
      updateGithubRepo: this.get('update_github_repo') ?? '',
      context7ApiKey: this.get('context7_api_key') ?? '',
      notificationsEnabled: this.getBool('notifications_enabled', true),
      parallelBuildAgents: this.getInt('parallel_build_agents', 3, 1, 6),
      leanBuildMcp: this.getBool('lean_build_mcp', false),
      userAvatarVariant: ((): UserAvatarVariant => {
        const raw = this.get('user_avatar_variant')
        return raw === '1' || raw === '2' || raw === '3' ? raw : '1'
      })(),
      maxStreamLifetimeMin: this.getInt('max_stream_lifetime_min', 30, 10, 120),
      dagScheduling: this.getBool('dag_scheduling', true),
      blueprintAutoMode: this.getBool('blueprint_auto_mode', true),
      // E3 — default OFF: see the note on AppPreferences.verifyFeatureDiff.
      verifyFeatureDiff: this.getBool('verify_feature_diff', false),
      // P2 — default OFF: see the note on AppPreferences.blueprintFailureMemory.
      blueprintFailureMemory: this.getBool('blueprint_failure_memory', false)
    }
  }
}

export const appPreferenceRepository = new AppPreferenceRepository()

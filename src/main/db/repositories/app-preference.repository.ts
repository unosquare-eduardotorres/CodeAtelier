import { BaseRepository } from '../base-repository'
import type { AppPreferences, AppTheme, UpdateSourceProvider } from '../../../shared/types'

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
      | AppPreferenceRow
      | undefined
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
      updateGithubRepo: this.get('update_github_repo') ?? ''
    }
  }
}

export const appPreferenceRepository = new AppPreferenceRepository()

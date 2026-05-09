import { getDatabase } from '../index'
import type { AppPreferences, UpdateSourceProvider } from '../../../shared/types'

interface AppPreferenceRow {
  key: string
  value: string
  updated_at: string
}

export class AppPreferenceRepository {
  get(key: string): string | null {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM app_preferences WHERE key = ?').get(key) as
      | AppPreferenceRow
      | undefined
    return row ? row.value : null
  }

  set(key: string, value: string): void {
    const db = getDatabase()
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
      updateSource: (this.get('update_source') as UpdateSourceProvider) ?? 'drive',
      updateDrivePath: this.get('update_drive_path') ?? '',
      updateGithubOwner: this.get('update_github_owner') ?? '',
      updateGithubRepo: this.get('update_github_repo') ?? ''
    }
  }
}

export const appPreferenceRepository = new AppPreferenceRepository()

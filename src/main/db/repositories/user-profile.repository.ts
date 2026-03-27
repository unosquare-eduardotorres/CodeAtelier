import { getDatabase } from '../index'
import type { UserProfile } from '../../../shared/types'

interface UserProfileRow {
  id: string
  display_name: string
  avatar_key: string
  created_at: string
  updated_at: string
}

function mapRow(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class UserProfileRepository {
  getProfile(): UserProfile | null {
    const db = getDatabase()
    const row = db.prepare("SELECT * FROM user_profile WHERE id = 'default'").get() as
      | UserProfileRow
      | undefined
    return row ? mapRow(row) : null
  }

  upsertProfile(displayName: string, avatarKey: string): UserProfile {
    const db = getDatabase()
    const row = db
      .prepare(
        `
      INSERT INTO user_profile (id, display_name, avatar_key, updated_at)
      VALUES ('default', ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        avatar_key = excluded.avatar_key,
        updated_at = datetime('now')
      RETURNING *
    `
      )
      .get(displayName, avatarKey) as UserProfileRow
    return mapRow(row)
  }
}

export const userProfileRepository = new UserProfileRepository()

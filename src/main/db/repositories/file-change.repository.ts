import { getDatabase } from '../index'

interface FileChangeRow {
  id: string
  conversation_id: string
  file_path: string
  change_type: 'created' | 'modified' | 'deleted'
  created_at: string
}

export interface FileChange {
  id: string
  conversationId: string
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  createdAt: string
}

function mapRow(row: FileChangeRow): FileChange {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    filePath: row.file_path,
    changeType: row.change_type,
    createdAt: row.created_at
  }
}

export class FileChangeRepository {
  /** Upsert a file change — INSERT OR REPLACE on (conversation_id, file_path) */
  track(
    conversationId: string,
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted' = 'modified'
  ): void {
    const db = getDatabase()
    db.prepare(
      `
      INSERT INTO conversation_file_changes (conversation_id, file_path, change_type)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id, file_path) DO UPDATE SET
        change_type = excluded.change_type,
        created_at = datetime('now')
    `
    ).run(conversationId, filePath, changeType)
  }

  /** Get all tracked file changes for a conversation */
  findByConversation(conversationId: string): FileChange[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM conversation_file_changes WHERE conversation_id = ? ORDER BY created_at'
      )
      .all(conversationId) as FileChangeRow[]
    return rows.map(mapRow)
  }

  /** Clear all tracked file changes for a conversation (post-commit cleanup) */
  clearByConversation(conversationId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM conversation_file_changes WHERE conversation_id = ?').run(
      conversationId
    )
  }

  /** Delete all tracked file changes for a conversation (on conversation delete) */
  deleteByConversation(conversationId: string): void {
    this.clearByConversation(conversationId)
  }
}

export const fileChangeRepository = new FileChangeRepository()

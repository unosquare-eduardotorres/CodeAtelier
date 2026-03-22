import { getDatabase } from '../index';
import type { Message } from '../../../shared/types';

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'coordinator' | 'specialist' | 'generalist';
  agent_id: string | null;
  content_md: string;
  attachments_json: string;
  created_at: string;
}

function mapRow(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    agentId: row.agent_id ?? undefined,
    contentMd: row.content_md,
    attachmentsJson: row.attachments_json,
    createdAt: row.created_at
  };
}

export class MessageRepository {
  create(
    conversationId: string,
    role: 'user' | 'coordinator' | 'specialist' | 'generalist',
    contentMd: string,
    agentId?: string,
    attachmentsJson?: string
  ): Message {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO messages (conversation_id, role, content_md, agent_id, attachments_json)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);
    const row = stmt.get(
      conversationId,
      role,
      contentMd,
      agentId ?? null,
      attachmentsJson ?? '[]'
    ) as MessageRow;
    return mapRow(row);
  }

  findByConversation(conversationId: string): Message[] {
    const db = getDatabase();
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(conversationId) as MessageRow[];
    return rows.map(mapRow);
  }

  findById(id: string): Message | undefined {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
    const row = stmt.get(id) as MessageRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}

export const messageRepository = new MessageRepository();

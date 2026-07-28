/**
 * todo.repository — CRUD for persistent conversation todos.
 *
 * Todos are ephemeral in the Zustand store but persisted here so they
 * survive app restarts. Each mutation is called from the chunk-router
 * when a todo_update StreamChunk arrives.
 */

import { getDatabase } from '../index'

export interface TodoItem {
  id: number
  conversationId: string
  text: string
  completed: boolean
  itemIndex: number | null
  createdAt: string
  updatedAt: string
}

interface TodoRow {
  id: number
  conversation_id: string
  text: string
  completed: number
  item_index: number | null
  created_at: string
  updated_at: string
}

function db() {
  return getDatabase()
}

function mapRow(row: TodoRow): TodoItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    completed: row.completed === 1,
    itemIndex: row.item_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class TodoRepository {
  saveTodo(conversationId: string, text: string, index?: number): void {
    db()
      .prepare(
        `INSERT INTO conversation_todos (conversation_id, text, item_index)
         VALUES (?, ?, ?)`
      )
      .run(conversationId, text, index ?? null)
  }

  completeTodo(conversationId: string, text: string, index?: number): void {
    // Match by text (and optionally index) to handle cases where the todo
    // text is the unique identifier from the agent.
    if (index != null) {
      db()
        .prepare(
          `UPDATE conversation_todos
           SET completed = 1, updated_at = datetime('now')
           WHERE conversation_id = ? AND text = ? AND item_index = ?`
        )
        .run(conversationId, text, index)
    } else {
      db()
        .prepare(
          `UPDATE conversation_todos
           SET completed = 1, updated_at = datetime('now')
           WHERE conversation_id = ? AND text = ?`
        )
        .run(conversationId, text)
    }
  }

  removeTodo(conversationId: string, text: string, index?: number): void {
    if (index != null) {
      db()
        .prepare(
          'DELETE FROM conversation_todos WHERE conversation_id = ? AND text = ? AND item_index = ?'
        )
        .run(conversationId, text, index)
    } else {
      db()
        .prepare('DELETE FROM conversation_todos WHERE conversation_id = ? AND text = ?')
        .run(conversationId, text)
    }
  }

  findByConversation(conversationId: string): TodoItem[] {
    const rows = db()
      .prepare(
        `SELECT id, conversation_id, text, completed, item_index, created_at, updated_at
         FROM conversation_todos
         WHERE conversation_id = ?
         ORDER BY created_at ASC`
      )
      .all(conversationId) as TodoRow[]
    return rows.map(mapRow)
  }

  clearByConversation(conversationId: string): void {
    db()
      .prepare('DELETE FROM conversation_todos WHERE conversation_id = ?')
      .run(conversationId)
  }
}

export const todoRepository = new TodoRepository()

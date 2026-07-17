/**
 * Pure-logic helpers extracted from ChatStreamService for testability.
 *
 * These functions are side-effect-free (no DB, no FS, no IPC) and handle:
 * - Attachment formatting (given pre-read content/metadata)
 * - Stream identity computation (role/phase/specialist from adapter state)
 */

import type { ConversationPhase } from '../../shared/types'

// ── Attachment Formatting ──

export interface ImageAttachmentData {
  base64: string
  mimeType: string
  fileName: string
}

export interface TextAttachmentData {
  content: string
  tokens: number
  filePath: string
}

export interface FailedAttachmentData {
  filePath: string
  error: string
}

/**
 * Format an image attachment as a markdown annotation.
 */
export function formatImageAttachment(data: ImageAttachmentData): string {
  return `\n---\n**Attached image: ${data.fileName}** (${data.mimeType}) — visible in the conversation\n`
}

/**
 * Format a text file attachment as a code-fenced block with metadata.
 */
export function formatTextAttachment(data: TextAttachmentData): string {
  return `\n---\n**Attached file: ${data.filePath}** (${data.tokens} tokens)\n\`\`\`\n${data.content}\n\`\`\`\n`
}

/**
 * Format a failed attachment read as an inline error.
 */
export function formatFailedAttachment(data: FailedAttachmentData): string {
  return `\n---\n**Failed to read: ${data.filePath}**: ${data.error}\n`
}

/**
 * Extract the file name from a path (supports forward and backward slashes).
 */
export function extractFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath.split('\\').pop() || 'image'
}

/**
 * Assemble multiple formatted attachment parts into a single text content string.
 */
export function assembleAttachmentText(parts: string[]): string {
  return parts.join('')
}

// ── Stream Identity ──

export interface StreamIdentityInput {
  /** The active message role from the adapter ('specialist') */
  messageRole: 'specialist'
  /** The adapter's current agent ID */
  adapterAgentId: string
  /** Optional persona overlay (specialist impersonating a named specialist) */
  persona: { agentId: string } | null
}

export interface StreamIdentityResult {
  streamingRole: 'specialist'
  phase: ConversationPhase
  specialistMeta: { specialist: string; taskId?: string } | undefined
  adapterAgentId: string
}

/**
 * Compute the streaming identity from adapter state inputs.
 *
 * When a persona overlay is active, the specialist impersonates a named specialist
 * so the avatar is consistent across streaming, finalization, and DB reload.
 */
export function computeStreamIdentity(input: StreamIdentityInput): StreamIdentityResult {
  const { messageRole, adapterAgentId, persona } = input

  const streamingRole: 'specialist' = persona ? 'specialist' : messageRole
  const phase: ConversationPhase =
    streamingRole === 'specialist' ? 'specialist-executing' : 'specialist-responding'
  const specialistMeta = persona
    ? { specialist: persona.agentId, taskId: '' }
    : messageRole === 'specialist'
      ? { specialist: adapterAgentId }
      : undefined

  return { streamingRole, phase, specialistMeta, adapterAgentId }
}

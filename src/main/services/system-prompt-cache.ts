/**
 * SystemPromptCache — extracted cache for assembled system prompts.
 *
 * Pattern 7 centralization: the legacy prompt assembler and
 * ProjectSpecialistRoleAdapter maintained identical 5-field caches with
 * matching invalidation logic. This class provides a single implementation.
 *
 * Cache keys: mode, conversationId, tone, model.
 * Always rebuilds on turn 1 to pick up latest settings (CLAUDE.md, skills).
 */

import type { CommunicationTone, ConversationMode } from '../../shared/types'

export interface SystemPromptCacheKeys {
  mode: ConversationMode
  conversationId: string | null
  tone: CommunicationTone
  model: string | null
}

export class SystemPromptCache {
  private snapshot: string | null = null
  private keys: SystemPromptCacheKeys = {
    mode: 'plan',
    conversationId: null,
    tone: 'default',
    model: null
  }

  /**
   * Check if the cached prompt is still valid for the given turn.
   * Returns false on turn 1 (always rebuild) or when any key changed.
   */
  isValid(currentKeys: SystemPromptCacheKeys, turnCount: number): boolean {
    return (
      turnCount > 1 &&
      this.snapshot !== null &&
      this.keys.mode === currentKeys.mode &&
      this.keys.conversationId === currentKeys.conversationId &&
      this.keys.tone === currentKeys.tone &&
      this.keys.model === currentKeys.model
    )
  }

  /** Store a new prompt and its cache keys. */
  set(prompt: string, keys: SystemPromptCacheKeys): void {
    this.snapshot = prompt
    this.keys = { ...keys }
  }

  /** Get the cached prompt (null if not cached). */
  get(): string | null {
    return this.snapshot
  }

  /** Invalidate the cache — forces rebuild on next turn. */
  invalidate(): void {
    this.snapshot = null
    this.keys = {
      mode: 'plan',
      conversationId: null,
      tone: 'default',
      model: null
    }
  }
}

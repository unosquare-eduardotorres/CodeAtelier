import { useChatBubbleSize } from '@renderer/store/app-preference.store'
import type { ChatBubbleSize } from '../../../shared/types'

/**
 * Maps the user's bubble-size preference to the appropriate Avatar size.
 * Mirrors the AVATAR_SIZE_MAP formerly in MessageBubble — extracted here so
 * every chat surface (Grill, Blueprint, Audit, ThinkingIndicator) stays in sync.
 */
const AVATAR_SIZE_MAP: Record<ChatBubbleSize, 'md' | 'lg' | 'xl'> = {
  small: 'md', // 48px
  medium: 'lg', // 64px
  large: 'xl', // 80px
  xl: 'xl' // 80px
}

export function useChatAvatarSize(): 'md' | 'lg' | 'xl' {
  const bubbleSize = useChatBubbleSize()
  return AVATAR_SIZE_MAP[bubbleSize]
}

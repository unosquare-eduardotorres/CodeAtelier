import { useAppPreferenceActions, useChatBubbleSize } from '@renderer/store'
import type { ChatBubbleSize } from '../../../../shared/types'

const BUBBLE_SIZE_OPTIONS: { value: ChatBubbleSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: 'Compact text, tighter bubbles' },
  { value: 'medium', label: 'Medium', description: 'Balanced readability' },
  { value: 'large', label: 'Large', description: 'Comfortable reading' },
  { value: 'xl', label: 'XL', description: 'Maximum readability' }
]

export default function ChatBubbleSizeSection(): React.JSX.Element {
  const currentSize = useChatBubbleSize()
  const { setPreference } = useAppPreferenceActions()

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Chat Bubble Size</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-3">
        Control the text size and width of chat message bubbles.
      </p>
      <div className="grid grid-cols-4 gap-2">
        {BUBBLE_SIZE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => {
              void setPreference('chatBubbleSize', opt.value).catch(console.error)
            }}
            className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
              currentSize === opt.value
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            <span>{opt.label}</span>
            <span className="text-[10px] text-text-muted font-normal">{opt.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react'

// ── Tier Ladder data ──

const TIERS = [
  { label: 'T0 Observed', confirms: '—', color: 'text-text-muted', dotColor: 'bg-text-muted' },
  { label: 'T1 Confirmed', confirms: '3', color: 'text-info', dotColor: 'bg-info' },
  { label: 'T2 Established', confirms: '5', color: 'text-success', dotColor: 'bg-success' },
  { label: 'T3 Wisdom', confirms: '8', color: 'text-primary-text', dotColor: 'bg-primary-text' }
]

const CATEGORIES = [
  { icon: '🏗️', label: 'Decision', desc: 'Architectural/technology choices' },
  { icon: '📐', label: 'Convention', desc: 'Patterns the codebase follows' },
  { icon: '⚠️', label: 'Gotcha', desc: 'Traps and non-obvious constraints' },
  { icon: '⚙️', label: 'Preference', desc: 'How you like things done' },
  { icon: '📎', label: 'Reference', desc: 'Pointers to docs and files' }
]

// ── Component ──

export default function MemoryExplainer(): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="border border-border-default rounded-md">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
        aria-expanded={isOpen}
        aria-label="How the Brain works"
      >
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <HelpCircle className="w-4 h-4" />
        <span>How the Brain works</span>
      </button>

      {isOpen && (
        <div className="px-3 pb-3 space-y-4 text-xs text-text-secondary">
          {/* Tier Ladder */}
          <div>
            <p className="font-medium text-text-primary mb-2">Promotion Ladder</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {TIERS.map((tier, i) => (
                <div key={tier.label} className="flex items-center gap-1.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-overlay ${tier.color} font-mono`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${tier.dotColor}`} />
                    {tier.label}
                  </span>
                  {i < TIERS.length - 1 && (
                    <span className="text-text-muted">
                      →<span className="text-[10px] align-super ml-0.5">{TIERS[i + 1].confirms}×</span>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-text-muted">
              Each confirmation from a session or agent bumps the count.
              Higher tiers rank higher in retrieval and survive longer.
              Wisdom (T3) additionally requires human confirmations and a 30-day evidence span.
            </p>
          </div>

          {/* Categories */}
          <div>
            <p className="font-medium text-text-primary mb-2">Categories</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {CATEGORIES.map((cat) => (
                <div key={cat.label} className="flex items-center gap-1.5">
                  <span>{cat.icon}</span>
                  <span className="font-medium text-text-primary">{cat.label}</span>
                  <span className="text-text-muted">— {cat.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Learn more */}
          <p className="text-text-muted">
            Memories are automatically extracted from sessions, commits, and documents.
            Contradictions are detected and flagged for review.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * ReferenceDocList — grouped, collapsible list of attached reference documents.
 *
 * Groups documents by type (files vs URLs) with sub-headers.
 * Collapses groups with more than 4 items by default.
 * Used in both the blueprint input form (editable) and detail view (readonly).
 */

import { useState } from 'react'
import { FileText, FolderOpen, Link2, X, ChevronDown, ChevronRight } from 'lucide-react'
import type { ReferenceDocument } from '../../../../../shared/blueprint-types'

interface ReferenceDocListProps {
  documents: ReferenceDocument[]
  onRemove?: (index: number) => void
  readonly?: boolean
}

const TYPE_CONFIG = {
  file: { icon: FileText, color: 'text-blue-400' },
  'workspace-file': { icon: FolderOpen, color: 'text-amber-400' },
  url: { icon: Link2, color: 'text-purple-400' }
} as const

const GROUP_CONFIG = {
  files: {
    label: 'Files',
    icon: FileText,
    color: 'text-blue-400',
    types: new Set(['file', 'workspace-file'])
  },
  urls: { label: 'URLs', icon: Link2, color: 'text-purple-400', types: new Set(['url']) }
} as const

const COLLAPSED_LIMIT = 4

export default function ReferenceDocList({
  documents,
  onRemove,
  readonly = false
}: ReferenceDocListProps): React.JSX.Element | null {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  if (documents.length === 0) return null

  // Partition documents into groups, preserving original indices for onRemove
  const indexed = documents.map((doc, index) => ({ doc, index }))
  const fileItems = indexed.filter(
    ({ doc }) => doc.type === 'file' || doc.type === 'workspace-file'
  )
  const urlItems = indexed.filter(({ doc }) => doc.type === 'url')

  const groups = [
    { key: 'files', config: GROUP_CONFIG.files, items: fileItems },
    { key: 'urls', config: GROUP_CONFIG.urls, items: urlItems }
  ].filter((g) => g.items.length > 0)

  const toggleGroup = (key: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <div data-testid="reference-doc-list" className="space-y-2">
      {groups.map(({ key, config, items }) => {
        const isExpanded = expandedGroups.has(key)
        const needsCollapse = items.length > COLLAPSED_LIMIT
        const visible = needsCollapse && !isExpanded ? items.slice(0, COLLAPSED_LIMIT) : items
        const GroupIcon = config.icon

        return (
          <div key={key} className="space-y-1">
            {/* Group header — only shown when multiple groups exist */}
            {groups.length > 1 && (
              <div className="flex items-center gap-1.5">
                <GroupIcon size={11} className={config.color} />
                <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                  {config.label} ({items.length})
                </span>
              </div>
            )}
            {/* Chips */}
            <div className="flex flex-wrap gap-1.5">
              {visible.map(({ doc, index }) => {
                const chipConfig = TYPE_CONFIG[doc.type]
                const Icon = chipConfig.icon
                return (
                  <span
                    key={`${doc.type}-${doc.path}-${index}`}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-base border border-border-subtle text-xs group"
                    title={doc.path}
                  >
                    <Icon size={12} className={`flex-shrink-0 ${chipConfig.color}`} />
                    <span className="max-w-[220px] truncate text-text-secondary">{doc.name}</span>
                    {!readonly && onRemove && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onRemove(index)
                        }}
                        className="ml-0.5 text-text-muted hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
                        aria-label={`Remove ${doc.name}`}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </span>
                )
              })}
              {/* Expand/collapse toggle */}
              {needsCollapse && (
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {isExpanded ? 'Show less' : `+${items.length - COLLAPSED_LIMIT} more`}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Type scale for these surfaces — four steps, no arbitrary sizes below the
 * floor. Previously the same metadata line appeared at 10px, 11px and 12px in
 * neighbouring components with nothing to say which was right.
 *
 *   text-sm      (14px)  panel titles
 *   text-xs      (12px)  body, controls, list rows
 *   text-[11px]  (11px)  FLOOR — metadata, counts, captions, badges
 *   font-mono            numeric readouts, always with `tabular-nums`
 *
 * Anything smaller than 11px is unreadable on a 1x display; do not add
 * `text-[10px]` or `text-[9px]`.
 */

export { default as Button } from './Button'
export type { ButtonVariant, ButtonSize } from './Button'
export { default as Chip } from './Chip'
export { default as Meter } from './Meter'
export type { MeterTone } from './Meter'
export { default as StatPill } from './StatPill'
export type { StatTone } from './StatPill'
export { default as SegmentedControl } from './SegmentedControl'
export type { Segment } from './SegmentedControl'
export { default as Switch } from './Switch'
export { default as Tabs } from './Tabs'
export type { TabItem } from './Tabs'
export { default as Popover } from './Popover'
export { default as Tooltip } from './Tooltip'
export { default as FilterMenu } from './FilterMenu'
export type { FilterOption } from './FilterMenu'
export { default as SelectMenu } from './SelectMenu'
export type { SelectOption } from './SelectMenu'
export { default as PanelHeader } from './PanelHeader'

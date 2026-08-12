/**
 * ToolInputPreview — renders structured tool input for the permission modal.
 * Shows commands in monospace code blocks, file paths as badges, and other
 * inputs as key-value lists. No truncation — scrollable for long content.
 */

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

interface ToolInputPreviewProps {
  toolName: string
  input: Record<string, unknown>
}

/** Copy-to-clipboard button overlaid on code blocks. */
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = (): void => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 p-1 rounded bg-white/10 hover:bg-white/20 text-text-muted hover:text-text-primary transition-colors"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  )
}

/** Monospace code block with horizontal scroll and copy button. */
function CodeBlock({ value, label }: { value: string; label?: string }): React.JSX.Element {
  return (
    <div className="relative group">
      {label && (
        <span className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
          {label}
        </span>
      )}
      <div className="relative rounded-lg bg-black/40 border border-border-subtle overflow-hidden">
        <pre className="p-3 pr-10 text-[13px] font-mono text-text-primary overflow-x-auto overflow-y-auto max-h-[200px] whitespace-pre">
          {value}
        </pre>
        <CopyButton text={value} />
      </div>
    </div>
  )
}

/** Renders a file path as a highlighted inline badge. */
function PathBadge({ path }: { path: string }): React.JSX.Element {
  return (
    <code className="inline-block px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 text-[13px] font-mono border border-blue-500/20 break-all">
      {path}
    </code>
  )
}

/** Format a value for display — strings shown directly, objects as JSON. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

/** Bash tool — show description + command code block. */
function BashPreview({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const command = (input.command as string) ?? ''
  const description = input.description as string | undefined

  return (
    <div className="space-y-2">
      {description && (
        <p className="text-sm text-text-secondary">{description}</p>
      )}
      <CodeBlock value={command} />
    </div>
  )
}

/** File tools (Read/Write/Edit) — show file path badge + other params. */
function FileToolPreview({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const filePath = (input.file_path ?? input.filePath) as string | undefined
  const otherEntries = Object.entries(input).filter(
    ([k]) => k !== 'file_path' && k !== 'filePath'
  )

  return (
    <div className="space-y-2">
      {filePath && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-text-muted mr-2">File</span>
          <PathBadge path={filePath} />
        </div>
      )}
      {otherEntries.length > 0 && (
        <dl className="space-y-1.5">
          {otherEntries.map(([key, val]) => {
            const str = formatValue(val)
            const isLong = str.length > 80 || str.includes('\n')
            return (
              <div key={key}>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">{key}</dt>
                <dd className="mt-0.5">
                  {isLong ? (
                    <CodeBlock value={str} />
                  ) : (
                    <span className="text-sm text-text-primary font-mono">{str}</span>
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
    </div>
  )
}

/** Generic tool — key-value pairs with code blocks for long values. */
function GenericPreview({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const entries = Object.entries(input)

  return (
    <dl className="space-y-2">
      {entries.map(([key, val]) => {
        const str = formatValue(val)
        const isLong = str.length > 80 || str.includes('\n')
        return (
          <div key={key}>
            <dt className="text-[10px] uppercase tracking-wider text-text-muted">{key}</dt>
            <dd className="mt-0.5">
              {isLong ? (
                <CodeBlock value={str} />
              ) : (
                <span className="text-sm text-text-primary font-mono">{str}</span>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

const BASH_TOOLS = new Set(['Bash', 'bash'])
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'read', 'write', 'edit'])

export default function ToolInputPreview({
  toolName,
  input
}: ToolInputPreviewProps): React.JSX.Element {
  if (BASH_TOOLS.has(toolName)) {
    return <BashPreview input={input} />
  }
  if (FILE_TOOLS.has(toolName)) {
    return <FileToolPreview input={input} />
  }
  return <GenericPreview input={input} />
}

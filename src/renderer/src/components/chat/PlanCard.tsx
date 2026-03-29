import { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Hammer,
  RefreshCw,
  Check,
  ClipboardList,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FileCode,
  Copy
} from 'lucide-react'
import type { StructuredPlan, PlanStep, PlanSection } from '../../../../shared/types'
import { MermaidDiagram } from '@renderer/components/common'

interface PlanCardProps {
  planContent: string
  onBuild: () => void
  onRefine: () => void
}

/** Complexity badge colors */
const COMPLEXITY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-success-muted', text: 'text-success', label: 'Low' },
  medium: { bg: 'bg-mode-build-muted', text: 'text-mode-build-text', label: 'Medium' },
  high: { bg: 'bg-danger-muted', text: 'text-danger', label: 'High' }
}

function ComplexityBadge({ complexity }: { complexity: string }): React.JSX.Element {
  const colors = COMPLEXITY_COLORS[complexity] ?? COMPLEXITY_COLORS.medium
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors.bg} ${colors.text}`}>
      {colors.label}
    </span>
  )
}

function CollapsibleSection({
  section,
  defaultOpen = true
}: {
  section: PlanSection
  defaultOpen?: boolean
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div className="rounded-lg border border-mode-plan-border bg-mode-plan-muted overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-mode-plan/10 transition-colors text-left"
      >
        {isOpen ? (
          <ChevronDown size={14} className="text-mode-plan-text shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-mode-plan-text shrink-0" />
        )}
        {section.icon && <span className="text-base shrink-0">{section.icon}</span>}
        <span className="text-sm font-semibold text-mode-plan-text">{section.heading}</span>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-3">
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
          </div>
          {section.mermaid && (
            <div className="rounded-lg border border-border-subtle bg-surface-base p-3">
              <MermaidDiagram definition={section.mermaid} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StepsTable({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-mode-plan-border">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-mode-plan-muted border-b border-mode-plan-border">
            <th className="px-3 py-2 text-left text-xs font-medium text-mode-plan-text uppercase tracking-wider w-10">
              #
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium text-mode-plan-text uppercase tracking-wider">
              Step
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium text-mode-plan-text uppercase tracking-wider">
              Description
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium text-mode-plan-text uppercase tracking-wider">
              File
            </th>
            <th className="px-3 py-2 text-left text-xs font-medium text-mode-plan-text uppercase tracking-wider w-20">
              Complexity
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-mode-plan-border/30">
          {steps.map((step) => (
            <tr key={step.number} className="hover:bg-mode-plan-muted transition-colors">
              <td className="px-3 py-2 text-mode-plan-text font-mono text-xs">{step.number}</td>
              <td className="px-3 py-2 text-text-primary font-medium">{step.title}</td>
              <td className="px-3 py-2 text-text-body">{step.description}</td>
              <td className="px-3 py-2">
                {step.file && (
                  <code className="text-xs bg-surface-overlay px-1.5 py-0.5 rounded text-primary-text font-mono">
                    {step.file}
                  </code>
                )}
              </td>
              <td className="px-3 py-2">
                {step.complexity && <ComplexityBadge complexity={step.complexity} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FileList({ files }: { files: string[] }): React.JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = (filePath: string, index: number): void => {
    navigator.clipboard.writeText(filePath)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 1500)
  }

  return (
    <div className="space-y-1">
      {files.map((file, index) => (
        <div
          key={file}
          className="flex items-center gap-2 group cursor-pointer hover:bg-mode-plan-muted rounded px-2 py-1 transition-colors"
          onClick={() => handleCopy(file, index)}
        >
          <FileCode size={12} className="text-mode-plan-text shrink-0" />
          <code className="text-xs text-text-body font-mono flex-1">{file}</code>
          {copiedIndex === index ? (
            <Check size={12} className="text-success shrink-0" />
          ) : (
            <Copy size={12} className="text-text-muted opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
          )}
        </div>
      ))}
    </div>
  )
}

function StructuredPlanView({
  plan,
  onBuild,
  onRefine
}: {
  plan: StructuredPlan
  onBuild: () => void
  onRefine: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-success/30 bg-surface-overlay overflow-hidden shadow-sm">
      {/* Green header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-success-muted border-b border-success/20">
        <Check size={16} className="text-success" />
        <span className="text-sm font-semibold text-success">Implementation Plan Ready</span>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Title */}
        <div>
          <h3 className="text-base font-bold text-text-primary flex items-center gap-2">
            <ClipboardList size={16} className="text-mode-plan-text" />
            {plan.title}
          </h3>
        </div>

        {/* Executive Summary */}
        {plan.summary && (
          <div className="text-sm text-text-body bg-mode-plan-muted rounded-lg px-4 py-3 border border-mode-plan-border">
            {plan.summary}
          </div>
        )}

        {/* Sections */}
        {plan.sections && plan.sections.length > 0 && (
          <div className="space-y-3">
            {plan.sections.map((section, index) => (
              <CollapsibleSection
                key={`${section.heading}-${index}`}
                section={section}
                defaultOpen={index < 3}
              />
            ))}
          </div>
        )}

        {/* Steps Table */}
        {plan.steps && plan.steps.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <span className="text-mode-plan-text">📋</span>
              Implementation Steps
            </h4>
            <StepsTable steps={plan.steps} />
          </div>
        )}

        {/* Files Affected */}
        {plan.files && plan.files.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <FileCode size={14} className="text-mode-plan-text" />
              Files Affected ({plan.files.length})
            </h4>
            <FileList files={plan.files} />
          </div>
        )}

        {/* Risks */}
        {plan.risks && plan.risks.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-warning flex items-center gap-2">
              <AlertTriangle size={14} />
              Risks
            </h4>
            <ul className="space-y-1">
              {plan.risks.map((risk, index) => (
                <li key={index} className="flex items-start gap-2 text-sm text-text-body">
                  <span className="text-warning mt-0.5 shrink-0">•</span>
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-success/20 bg-surface-base/50">
        <button
          onClick={onBuild}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 press-scale"
        >
          <Hammer size={14} />
          Accept & Build
        </button>
        <button
          onClick={onRefine}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <RefreshCw size={14} />
          Revise Plan
        </button>
      </div>
    </div>
  )
}

export default function PlanCard({
  planContent,
  onBuild,
  onRefine
}: PlanCardProps): React.JSX.Element {
  // Try to parse as structured plan JSON
  const structuredPlan = useMemo<StructuredPlan | null>(() => {
    try {
      const parsed = JSON.parse(planContent)
      if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
        return parsed as StructuredPlan
      }
      return null
    } catch {
      return null
    }
  }, [planContent])

  // Structured plan rendering
  if (structuredPlan) {
    return <StructuredPlanView plan={structuredPlan} onBuild={onBuild} onRefine={onRefine} />
  }

  // Fallback: plain markdown rendering (backward compatible)
  return (
    <div className="rounded-xl border border-mode-plan-border bg-mode-plan-muted overflow-hidden shadow-sm">
      {/* Plan header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-mode-plan/15 border-b border-mode-plan-border">
        <ClipboardList size={14} className="text-mode-plan-text" />
        <span className="text-sm font-medium text-mode-plan-text">Implementation Plan</span>
      </div>

      {/* Plan content — rendered as markdown */}
      <div className="px-5 py-4 prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-mode-plan-border bg-mode-plan-muted">
        <button
          onClick={onBuild}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 press-scale"
        >
          <Hammer size={14} />
          Build This
        </button>
        <button
          onClick={onRefine}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <RefreshCw size={14} />
          Refine Plan
        </button>
      </div>
    </div>
  )
}

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import log from 'electron-log/main'
import { z } from 'zod'
import { MCP_TOOLS } from '../../shared/constants'
import { InvestigationReportSchema } from './specialist/structured-output'
import type { InvestigationReport } from '../../shared/types'

const controlLog = log.scope('SpecialistControl')

export interface SpecialistControlCallbacks {
  onInvestigationReport: (report: InvestigationReport) => void
}

export function createSpecialistControlMcpServer(
  callbacks: SpecialistControlCallbacks
): Record<string, McpServerConfig> {
  const config = createSdkMcpServer({
    name: MCP_TOOLS.SPECIALIST_CONTROL._SERVER,
    version: '1.0.0',
    tools: [
      {
        name: MCP_TOOLS.SPECIALIST_CONTROL.EMIT_INVESTIGATION_REPORT.tool,
        description:
          'Emit a structured investigation report with root cause analysis. ' +
          'Use this instead of writing investigation-report code fences. ' +
          'Required fields: problem, rootCause, proposedFix, filesAffected, impact, impactReason.',
        inputSchema: InvestigationReportSchema.shape as unknown as Record<string, z.ZodType>,
        handler: async (args) => {
          const report = InvestigationReportSchema.parse(args) as InvestigationReport
          controlLog.info(
            `[specialist-control:emit_investigation_report] problem="${report.problem.substring(0, 80)}" impact=${report.impact}`
          )
          callbacks.onInvestigationReport(report)
          return {
            content: [
              {
                type: 'text' as const,
                text: `Investigation report emitted. Impact: ${report.impact}. The coordinator will review your findings.`
              }
            ]
          }
        }
      }
    ]
  })

  return { 'specialist-control': config }
}

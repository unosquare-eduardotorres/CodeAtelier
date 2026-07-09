/**
 * PassRateTrendChart — line chart with gradient area fill showing pass-rate % across runs.
 * Click-to-select a run.
 */

import { useRef, useMemo } from 'react'
import type { E2ERunSummary } from '../../../../../shared/types'
import { useECharts } from './useECharts'
import { echarts } from './echarts-setup'
import type { EChartsOption } from 'echarts'

interface Props {
  runs: E2ERunSummary[]
  selectedRunId: string | null
  onSelectRun: (id: string) => void
}

export default function PassRateTrendChart({ runs, selectedRunId, onSelectRun }: Props): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)

  // Last 20 completed runs, oldest→newest
  const completed = useMemo(() => {
    return runs
      .filter((r) => r.status !== 'running')
      .slice(0, 20)
      .reverse()
  }, [runs])

  const option = useMemo<EChartsOption | null>(() => {
    if (completed.length < 2) return null

    const labels = completed.map((_, i) => `Run ${i + 1}`)
    const data = completed.map((r) => {
      const total = r.totalPassed + r.totalFailed + r.totalSkipped + r.totalError
      return total > 0 ? Math.round((r.totalPassed / total) * 100) : 0
    })

    const selectedIdx = completed.findIndex((r) => r.id === selectedRunId)

    return {
      grid: { left: 36, right: 12, top: 8, bottom: 24 },
      xAxis: { type: 'category', data: labels, boundaryGap: false },
      yAxis: { type: 'value', min: 0, max: 100, splitNumber: 4, axisLabel: { formatter: '{value}%' } },
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const p = (params as { dataIndex: number; value: number }[])[0]
          const run = completed[p.dataIndex]
          const total = run.totalPassed + run.totalFailed + run.totalSkipped + run.totalError
          return `<b>${p.value}% pass rate</b><br/>${run.totalPassed}/${total} passed`
        }
      },
      series: [{
        type: 'line',
        data,
        smooth: true,
        symbol: 'circle',
        symbolSize: (_, params) => (params.dataIndex === selectedIdx ? 10 : 5),
        itemStyle: {
          color: (params) => (params.dataIndex === selectedIdx ? '#3b82f6' : '#22c55e')
        },
        lineStyle: { color: '#22c55e', width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34, 197, 94, 0.25)' },
            { offset: 1, color: 'rgba(34, 197, 94, 0.02)' }
          ])
        },
        markLine: selectedIdx >= 0 ? {
          silent: true,
          symbol: 'none',
          data: [{ xAxis: selectedIdx }],
          lineStyle: { color: '#3b82f6', type: 'dashed', width: 1 }
        } : undefined
      }]
    }
  }, [completed, selectedRunId])

  useECharts(containerRef, option)

  if (completed.length < 2) return null

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: 160 }}
      onClick={(e) => {
        // Simple approximation: compute index from click x position
        const rect = (e.target as HTMLElement).closest('div')?.getBoundingClientRect()
        if (!rect || completed.length === 0) return
        const relX = e.clientX - rect.left - 36 // account for grid.left
        const usableWidth = rect.width - 36 - 12
        const idx = Math.round((relX / usableWidth) * (completed.length - 1))
        if (idx >= 0 && idx < completed.length) {
          onSelectRun(completed[idx].id)
        }
      }}
    />
  )
}

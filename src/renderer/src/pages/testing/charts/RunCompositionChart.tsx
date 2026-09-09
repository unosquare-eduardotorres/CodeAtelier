/**
 * RunCompositionChart — stacked bar chart showing passed/failed/error/skipped per run.
 */

import { useRef, useMemo } from 'react'
import type { E2ERunSummary } from '../../../../../shared/types'
import { useECharts } from './useECharts'
import { useChartColors } from './chart-theme'
import type { EChartsOption } from 'echarts'

interface Props {
  runs: E2ERunSummary[]
  selectedRunId: string | null
  onSelectRun: (id: string) => void
}

export default function RunCompositionChart({
  runs,
  selectedRunId,
  onSelectRun
}: Props): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const colors = useChartColors()

  const completed = useMemo(() => {
    return runs
      .filter((r) => r.status !== 'running')
      .slice(0, 20)
      .reverse()
  }, [runs])

  const option = useMemo<EChartsOption | null>(() => {
    if (completed.length < 2) return null

    const labels = completed.map((_, i) => `R${i + 1}`)
    const selectedIdx = completed.findIndex((r) => r.id === selectedRunId)

    const makeSeries = (
      name: string,
      color: string,
      getter: (r: E2ERunSummary) => number
    ): {
      name: string
      type: 'bar'
      stack: string
      barWidth: string
      data: { value: number; itemStyle: { color: string; opacity: number } }[]
      emphasis: object
    } => ({
      name,
      type: 'bar' as const,
      stack: 'total',
      barWidth: '60%',
      data: completed.map((r, i) => ({
        value: getter(r),
        itemStyle: {
          color,
          opacity: i === selectedIdx ? 1 : 0.7
        }
      })),
      emphasis: { itemStyle: { opacity: 1 } }
    })

    return {
      grid: { left: 32, right: 8, top: 8, bottom: 20 },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value', splitNumber: 3 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const ps = params as { seriesName: string; value: number; dataIndex: number }[]
          return (
            `<b>Run ${ps[0].dataIndex + 1}</b><br/>` +
            ps.map((p) => `${p.seriesName}: ${p.value}`).join('<br/>') +
            `<br/><span style="color:${colors.textSecondary}">Click to select</span>`
          )
        }
      },
      legend: { show: false },
      series: [
        makeSeries('Passed', colors.success, (r) => r.totalPassed),
        makeSeries('Failed', colors.danger, (r) => r.totalFailed),
        makeSeries('Error', colors.warning, (r) => r.totalError),
        makeSeries('Skipped', colors.muted, (r) => r.totalSkipped)
      ]
    }
  }, [completed, selectedRunId, colors])

  useECharts(containerRef, option)

  if (completed.length < 2) return null

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: 160 }}
      onClick={(e) => {
        const rect = (e.target as HTMLElement).closest('div')?.getBoundingClientRect()
        if (!rect || completed.length === 0) return
        const relX = e.clientX - rect.left - 32
        const usableWidth = rect.width - 32 - 8
        const barWidth = usableWidth / completed.length
        const idx = Math.floor(relX / barWidth)
        if (idx >= 0 && idx < completed.length) {
          onSelectRun(completed[idx].id)
        }
      }}
    />
  )
}

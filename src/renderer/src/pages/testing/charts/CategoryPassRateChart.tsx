/**
 * CategoryPassRateChart — horizontal bar chart showing per-category pass rate for a selected run.
 */

import { useRef, useMemo } from 'react'
import type { E2EResultSummary, E2EScenarioSummary } from '../../../../../shared/types'
import { useECharts } from './useECharts'
import type { EChartsOption } from 'echarts'

const CATEGORY_LABELS: Record<string, string> = {
  'chat-core': 'Chat Core',
  commands: 'Commands',
  tools: 'Tools',
  memory: 'Memory',
  planning: 'Planning',
  grill: 'Grill',
  council: 'Council',
  blueprints: 'Blueprints',
  mpa: 'MPA',
  audit: 'Audit',
  'code-intel': 'Code Intel'
}

interface Props {
  results: E2EResultSummary[]
  scenarios: E2EScenarioSummary[]
}

export default function CategoryPassRateChart({
  results,
  scenarios
}: Props): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)

  const option = useMemo<EChartsOption | null>(() => {
    if (results.length === 0) return null

    // Build category → { passed, total } map
    const categoryMap = new Map<string, { passed: number; total: number }>()
    for (const r of results) {
      if (r.status === 'queued') continue
      const scenario = scenarios.find((s) => s.id === r.scenarioId)
      const cat = scenario?.category ?? 'unknown'
      const entry = categoryMap.get(cat) ?? { passed: 0, total: 0 }
      entry.total++
      if (r.status === 'passed') entry.passed++
      categoryMap.set(cat, entry)
    }

    if (categoryMap.size === 0) return null

    const categories = Array.from(categoryMap.entries()).sort(([, a], [, b]) => {
      const rateA = a.total > 0 ? a.passed / a.total : 0
      const rateB = b.total > 0 ? b.passed / b.total : 0
      return rateA - rateB
    })

    const names = categories.map(([cat]) => CATEGORY_LABELS[cat] ?? cat)
    const rates = categories.map(([, v]) =>
      v.total > 0 ? Math.round((v.passed / v.total) * 100) : 0
    )

    return {
      grid: { left: 80, right: 32, top: 4, bottom: 4 },
      xAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%' },
        splitNumber: 4
      },
      yAxis: { type: 'category', data: names, axisLabel: { fontSize: 11 } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (params as { value: number; dataIndex: number }[])[0]
          const [, v] = categories[p.dataIndex]
          return `<b>${names[p.dataIndex]}</b><br/>${v.passed}/${v.total} passed (${p.value}%)`
        }
      },
      series: [
        {
          type: 'bar',
          data: rates.map((v) => ({
            value: v,
            itemStyle: {
              color: v >= 80 ? '#22c55e' : v >= 50 ? '#f59e0b' : '#ef4444',
              borderRadius: [0, 3, 3, 0]
            }
          })),
          barWidth: '55%',
          label: {
            show: true,
            position: 'right',
            formatter: '{c}%',
            fontSize: 10,
            color: '#94a3b8'
          }
        }
      ]
    }
  }, [results, scenarios])

  useECharts(containerRef, option)

  if (results.length === 0) return null

  const chartHeight = Math.max(
    100,
    new Set(
      results
        .map((r) => {
          const s = scenarios.find((sc) => sc.id === r.scenarioId)
          return s?.category
        })
        .filter(Boolean)
    ).size *
      28 +
      16
  )

  return <div ref={containerRef} style={{ width: '100%', height: chartHeight }} />
}

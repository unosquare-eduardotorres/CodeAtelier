/**
 * ECharts tree-shaken setup — register only what we use.
 * Import this module once (side-effect) before creating any charts.
 */

import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer
])

// ── Dark theme matching app palette ──

const DARK_THEME: Record<string, unknown> = {
  backgroundColor: 'transparent',
  textStyle: { color: '#94a3b8' }, // text-muted
  title: { textStyle: { color: '#e2e8f0' } },
  line: {
    itemStyle: { borderWidth: 2 },
    lineStyle: { width: 2 },
    symbolSize: 4,
    symbol: 'circle',
    smooth: true
  },
  bar: {
    itemStyle: { barBorderWidth: 0, barBorderColor: '#1e293b' }
  },
  categoryAxis: {
    axisLine: { show: true, lineStyle: { color: '#334155' } },
    axisTick: { show: false },
    axisLabel: { color: '#94a3b8', fontSize: 10 },
    splitLine: { show: false }
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#64748b', fontSize: 10 },
    splitLine: { lineStyle: { color: '#1e293b' } }
  },
  tooltip: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    textStyle: { color: '#e2e8f0', fontSize: 12 }
  },
  legend: {
    textStyle: { color: '#94a3b8', fontSize: 11 }
  },
  // Token palette: success / danger / warning / info / muted
  color: ['#22c55e', '#ef4444', '#f59e0b', '#3b82f6', '#64748b', '#8b5cf6']
}

echarts.registerTheme('agent-studio-dark', DARK_THEME)

export { echarts }
export type EChartsInstance = echarts.ECharts

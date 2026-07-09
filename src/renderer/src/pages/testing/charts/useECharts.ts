/**
 * useECharts — thin React hook for ECharts lifecycle.
 * Handles init, option updates, resize, and dispose.
 */

import { useEffect, useRef } from 'react'
import { echarts, type EChartsInstance } from './echarts-setup'
import type { EChartsOption } from 'echarts'

export function useECharts(
  containerRef: React.RefObject<HTMLDivElement | null>,
  option: EChartsOption | null
): void {
  const chartRef = useRef<EChartsInstance | null>(null)

  // Init + dispose
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = echarts.init(el, 'agent-studio-dark', { renderer: 'canvas' })
    chartRef.current = chart

    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [containerRef])

  // Update option
  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, { notMerge: true })
    }
  }, [option])
}

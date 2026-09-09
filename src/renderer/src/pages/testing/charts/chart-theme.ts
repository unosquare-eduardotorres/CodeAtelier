/**
 * chart-theme — resolves theme CSS variables into concrete color strings for ECharts.
 * ECharts (canvas) cannot consume `var(--token)`, so values are read from the
 * active theme at render time and re-resolved whenever the theme changes.
 */

import { useMemo } from 'react'
import { useAppTheme } from '@renderer/store'
import type { AppTheme } from '../../../../../shared/types'

export interface ChartColors {
  success: string
  warning: string
  danger: string
  info: string
  muted: string
  textSecondary: string
}

// Fallbacks mirror the default code-atelier theme so charts stay legible even
// if a token is missing or getComputedStyle runs before styles apply.
const FALLBACK: ChartColors = {
  success: '#5db88a',
  warning: '#d49353',
  danger: '#c46b6b',
  info: '#6b9ec4',
  muted: '#889094',
  textSecondary: '#a2a8ac'
}

const TOKEN_VARS: Record<keyof ChartColors, string> = {
  success: '--color-success',
  warning: '--color-warning',
  danger: '--color-danger',
  info: '--color-info',
  muted: '--color-text-muted',
  textSecondary: '--color-text-secondary'
}

function resolveToken(varName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

export function useChartColors(): ChartColors {
  const theme = useAppTheme()
  return useMemo(
    () => ({
      success: resolveToken(TOKEN_VARS.success, FALLBACK.success),
      warning: resolveToken(TOKEN_VARS.warning, FALLBACK.warning),
      danger: resolveToken(TOKEN_VARS.danger, FALLBACK.danger),
      info: resolveToken(TOKEN_VARS.info, FALLBACK.info),
      muted: resolveToken(TOKEN_VARS.muted, FALLBACK.muted),
      textSecondary: resolveToken(TOKEN_VARS.textSecondary, FALLBACK.textSecondary)
    }),
    // `theme` is the memo buster: token values are static per theme, so the
    // identity of the resolved object must change when the theme does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme]
  )
}

/** Apply an alpha to a #rrggbb color for gradient area fills. */
export function withAlpha(hex: string, alpha: number): string {
  const c = hex.replace('#', '')
  if (c.length !== 6) return hex
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export type { AppTheme }

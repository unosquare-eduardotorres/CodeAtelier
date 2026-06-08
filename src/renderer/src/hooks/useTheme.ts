import { useEffect } from 'react'
import { useAppTheme } from '@renderer/store'
import type { AppTheme } from '../../../shared/types'

const VALID_THEMES: AppTheme[] = ['code-atelier', 'glass', 'porcelain', 'developer']

/**
 * Applies the active theme by setting `data-theme` on `<html>`.
 * Falls back to `code-atelier` for invalid values.
 * Call once at the top of the component tree (App.tsx).
 */
export function useTheme(): void {
  const theme = useAppTheme()

  useEffect(() => {
    const resolved = VALID_THEMES.includes(theme) ? theme : 'code-atelier'
    document.documentElement.setAttribute('data-theme', resolved)
  }, [theme])
}

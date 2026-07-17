import { useEffect } from 'react'

/**
 * Global error capture hook — call once at App root level.
 * Captures uncaught JS errors and unhandled promise rejections
 * and reports them to the bug tracker via IPC.
 */
export function useBugCapture(): void {
  useEffect(() => {
    function parseStack(stack?: string): {
      sourceFile?: string
      sourceLine?: number
      sourceColumn?: number
    } {
      if (!stack) return {}
      const match = stack.match(/at .+\((.+):(\d+):(\d+)\)/) || stack.match(/at (.+):(\d+):(\d+)/)
      if (match) {
        return {
          sourceFile: match[1],
          sourceLine: parseInt(match[2], 10),
          sourceColumn: parseInt(match[3], 10)
        }
      }
      return {}
    }

    function reportError(error: Error, severity: 'error' | 'fatal'): void {
      try {
        const parsed = parseStack(error.stack)
        window.api.reportBug({
          process: 'renderer',
          severity,
          errorMessage: error.message,
          stackTrace: error.stack,
          sourceFile: parsed.sourceFile,
          sourceLine: parsed.sourceLine,
          sourceColumn: parsed.sourceColumn,
          activeView: document.title || undefined,
          appVersion: navigator.userAgent.match(/CodeAtelier\/([\d.]+)/)?.[1] ?? 'unknown',
          osInfo: navigator.userAgent
        })
      } catch {
        // Don't let the bug reporter crash the error handler
      }
    }

    /** Errors that are benign browser/engine noise — not actionable bugs. */
    const BENIGN_ERROR_PATTERNS = [
      /ResizeObserver loop/i // Chromium: loop completed with undelivered notifications / loop limit exceeded
    ]

    function isBenignError(message: string): boolean {
      return BENIGN_ERROR_PATTERNS.some((p) => p.test(message))
    }

    function handleError(event: ErrorEvent): void {
      if (isBenignError(event.message)) return // Skip noise

      if (event.error instanceof Error) {
        reportError(event.error, 'error')
      } else {
        reportError(new Error(event.message || 'Unknown error'), 'error')
      }
    }

    function handleRejection(event: PromiseRejectionEvent): void {
      const error =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason ?? 'Unhandled promise rejection'))
      reportError(error, 'error')
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])
}

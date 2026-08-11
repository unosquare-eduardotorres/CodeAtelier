import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /**
   * Escape hatch for persistent bad state. "Try Again" only clears `hasError`,
   * so if the render throws deterministically (e.g. a malformed record being
   * hydrated) the boundary re-throws instantly and the user is stuck. Supplying
   * this renders a second action that navigates away from whatever is broken
   * before clearing the error.
   */
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // electron-log's initialize() auto-captures renderer errors,
    // but we log explicitly for component stack traces
    console.error('[ErrorBoundary] React component error:', error, info.componentStack)

    // Report to bug tracker
    try {
      // Extract component name from component stack
      const componentName = info.componentStack?.match(/at (\w+)/)?.[1] ?? undefined

      // Parse source file/line from error stack
      let sourceFile: string | undefined
      let sourceLine: number | undefined
      let sourceColumn: number | undefined
      if (error.stack) {
        const match =
          error.stack.match(/at .+\((.+):(\d+):(\d+)\)/) || error.stack.match(/at (.+):(\d+):(\d+)/)
        if (match) {
          sourceFile = match[1]
          sourceLine = parseInt(match[2], 10)
          sourceColumn = parseInt(match[3], 10)
        }
      }

      window.api.reportBug({
        process: 'renderer',
        severity: 'error',
        errorMessage: error.message,
        stackTrace: error.stack,
        sourceFile,
        sourceLine,
        sourceColumn,
        componentName,
        activeView: document.title || undefined,
        appVersion: navigator.userAgent.match(/CodeAtelier\/([\d.]+)/)?.[1] ?? 'unknown',
        osInfo: navigator.userAgent
      })
    } catch {
      // Don't let bug reporting crash the error boundary
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div
            data-testid="error-boundary-fallback"
            className="flex items-center justify-center h-full p-8 text-center"
          >
            <div>
              <h2 className="text-lg font-semibold text-danger mb-2">Something went wrong</h2>
              <p className="text-text-secondary text-sm mb-4">{this.state.error?.message}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => this.setState({ hasError: false, error: null })}
                  className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover text-sm transition-colors"
                >
                  Try Again
                </button>
                {this.props.onReset && (
                  <button
                    data-testid="error-boundary-reset"
                    onClick={() => {
                      this.props.onReset?.()
                      this.setState({ hasError: false, error: null })
                    }}
                    className="px-4 py-2 bg-surface-raised text-text-primary border border-border rounded-lg hover:bg-surface-hover text-sm transition-colors"
                  >
                    Back to Chat
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      )
    }
    return this.props.children
  }
}

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
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
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center justify-center h-full p-8 text-center">
            <div>
              <h2 className="text-lg font-semibold text-danger mb-2">Something went wrong</h2>
              <p className="text-text-secondary text-sm mb-4">{this.state.error?.message}</p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover text-sm transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )
      )
    }
    return this.props.children
  }
}

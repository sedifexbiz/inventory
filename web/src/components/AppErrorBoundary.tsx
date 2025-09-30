import { Component, ErrorInfo, ReactNode, useCallback } from 'react'
import { useToast } from './ToastProvider'

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  hasError: boolean
  error?: Error
}

type InternalBoundaryProps = {
  onError: (error: Error, info: ErrorInfo) => void
  onReset?: () => void
  children: ReactNode
}

class InternalErrorBoundary extends Component<InternalBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    error: undefined,
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError(error, info)
  }

  handleTryAgain = () => {
    this.setState({
      hasError: false,
      error: undefined,
    })
    this.props.onReset?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" aria-live="polite" aria-atomic="true" className="app-error-boundary">
          <h1>Something went wrong</h1>
          <p>We hit a snag while loading this section. Please try again.</p>
          {import.meta.env.DEV && this.state.error?.message ? (
            <p className="app-error-boundary__details">
              <strong>Details:</strong>{' '}
              <span data-testid="app-error-boundary-details">{this.state.error.message}</span>
            </p>
          ) : null}
          <button type="button" onClick={this.handleTryAgain}>
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export function AppErrorBoundary({ children }: AppErrorBoundaryProps) {
  const { publish } = useToast()

  const notifyError = useCallback(
    (error: Error) => {
      const message = error?.message?.trim()
      publish({
        tone: 'error',
        message: message ? `Something went wrong: ${message}` : 'Something went wrong. Please try again.',
        duration: 8000,
      })
    },
    [publish],
  )

  const handleError = useCallback(
    (error: Error, info: ErrorInfo) => {
      notifyError(error)
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.error('AppErrorBoundary caught an error', error, info)
      }
    },
    [notifyError],
  )

  const handleReset = useCallback(() => {
    publish({
      tone: 'info',
      message: 'Retrying…',
      duration: 3000,
    })
  }, [publish])

  return (
    <InternalErrorBoundary onError={handleError} onReset={handleReset}>
      {children}
    </InternalErrorBoundary>
  )
}

export default AppErrorBoundary

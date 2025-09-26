import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

type ToastTone = 'info' | 'success' | 'error'

interface ToastOptions {
  message: string
  tone?: ToastTone
  duration?: number
}

interface ToastEntry {
  id: number
  message: string
  tone: ToastTone
  duration: number
}

interface ToastContextValue {
  publish: (options: ToastOptions) => number
  dismiss: (id?: number) => void
}

const DEFAULT_DURATION = 5000

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])

  const dismiss = useCallback((id?: number) => {
    setToasts(current => {
      if (typeof id === 'number') {
        return current.filter(toast => toast.id !== id)
      }

      return []
    })
  }, [])

  const publish = useCallback((options: ToastOptions) => {
    const message = options.message.trim()
    if (!message) {
      return -1
    }

    const toast: ToastEntry = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      message,
      tone: options.tone ?? 'info',
      duration: options.duration ?? DEFAULT_DURATION
    }

    setToasts(current => [...current, toast])

    if (toast.duration > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => dismiss(toast.id), toast.duration)
    }

    return toast.id
  }, [dismiss])

  const value = useMemo(() => ({ publish, dismiss }), [publish, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map(toast => (
          <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }

  return context
}

interface ToastProps {
  toast: ToastEntry
  onDismiss: (id: number) => void
}

function Toast({ toast, onDismiss }: ToastProps) {
  const role = toast.tone === 'error' ? 'alert' : 'status'
  const ariaLive = toast.tone === 'error' ? 'assertive' : 'polite'

  return (
    <div
      className={`toast toast--${toast.tone}`}
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
    >
      <span className="toast__indicator" aria-hidden="true" />
      <span className="toast__message">{toast.message}</span>
      <button
        type="button"
        className="toast__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  )
}

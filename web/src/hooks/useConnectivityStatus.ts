import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const HEARTBEAT_URL = import.meta.env.VITE_HEARTBEAT_URL ?? '/heartbeat.json'
const DEFAULT_HEARTBEAT_INTERVAL = 30_000

type QueueStatusValue = 'idle' | 'pending' | 'processing' | 'error'

type QueueState = {
  status: QueueStatusValue
  pending: number
  lastError: string | null
  updatedAt: number | null
}

type ConnectivityState = {
  isOnline: boolean
  isReachable: boolean
  isChecking: boolean
  lastHeartbeatAt: number | null
  heartbeatError: string | null
  queue: QueueState
}

type QueueStatusMessage = {
  type: 'QUEUE_STATUS'
  status?: unknown
  pending?: unknown
  error?: unknown
}

type ServiceWorkerMessage = MessageEvent['data']

function parseQueueStatus(value: unknown): QueueStatusValue {
  if (value === 'processing' || value === 'pending' || value === 'error') {
    return value
  }
  return 'idle'
}

function normalizeQueuePending(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  return 0
}

export type ConnectivitySnapshot = ConnectivityState & {
  checkHeartbeat: () => Promise<void>
}

export function useConnectivityStatus(intervalMs = DEFAULT_HEARTBEAT_INTERVAL): ConnectivitySnapshot {
  const [state, setState] = useState<ConnectivityState>(() => ({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isReachable: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isChecking: false,
    lastHeartbeatAt: null,
    heartbeatError: null,
    queue: {
      status: 'idle',
      pending: 0,
      lastError: null,
      updatedAt: null,
    },
  }))
  const isMountedRef = useRef(true)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const heartbeatUrl = HEARTBEAT_URL
  const interval = Math.max(5_000, intervalMs)

  const runHeartbeat = useCallback(async () => {
    const now = Date.now()
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true

    if (!isMountedRef.current) return

    if (!online) {
      setState(prev => ({
        ...prev,
        isOnline: false,
        isReachable: false,
        isChecking: false,
        heartbeatError: null,
        lastHeartbeatAt: now,
      }))
      return
    }

    setState(prev => ({
      ...prev,
      isOnline: true,
      isChecking: true,
    }))

    try {
      const response = await fetch(`${heartbeatUrl}?ts=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      if (!isMountedRef.current) return

      setState(prev => ({
        ...prev,
        isReachable: true,
        isChecking: false,
        heartbeatError: null,
        lastHeartbeatAt: Date.now(),
      }))
    } catch (error) {
      if (!isMountedRef.current) return

      setState(prev => ({
        ...prev,
        isReachable: false,
        isChecking: false,
        heartbeatError: error instanceof Error ? error.message : 'Heartbeat failed',
        lastHeartbeatAt: Date.now(),
      }))
    }
  }, [heartbeatUrl])

  useEffect(() => {
    void runHeartbeat()
    const timer = window.setInterval(() => {
      void runHeartbeat()
    }, interval)

    return () => {
      window.clearInterval(timer)
    }
  }, [interval, runHeartbeat])

  useEffect(() => {
    function handleOnline() {
      setState(prev => ({
        ...prev,
        isOnline: true,
      }))
      void runHeartbeat()
    }

    function handleOffline() {
      const now = Date.now()
      setState(prev => ({
        ...prev,
        isOnline: false,
        isReachable: false,
        isChecking: false,
        heartbeatError: null,
        lastHeartbeatAt: now,
      }))
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [runHeartbeat])

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void runHeartbeat()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [runHeartbeat])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return
    }

    const handleMessage = (event: MessageEvent<ServiceWorkerMessage>) => {
      const data = event.data
      if (!data || typeof data !== 'object') {
        return
      }

      if ((data as QueueStatusMessage).type === 'QUEUE_STATUS') {
        const queueData = data as QueueStatusMessage
        const pending = normalizeQueuePending(queueData.pending)
        setState(prev => ({
          ...prev,
          queue: {
            status: pending === 0 ? 'idle' : parseQueueStatus(queueData.status),
            pending,
            lastError:
              typeof queueData.error === 'string' && queueData.error.trim().length > 0
                ? queueData.error
                : null,
            updatedAt: Date.now(),
          },
        }))
      }
    }

    navigator.serviceWorker.addEventListener('message', handleMessage)

    navigator.serviceWorker.ready
      .then(registration => {
        const controller = registration.active ?? registration.waiting ?? registration.installing
        controller?.postMessage({ type: 'REQUEST_QUEUE_STATUS' })
      })
      .catch(() => {
        // No-op: service worker may not be registered yet.
      })

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage)
    }
  }, [])

  return useMemo(
    () => ({
      ...state,
      checkHeartbeat: runHeartbeat,
    }),
    [state, runHeartbeat]
  )
}

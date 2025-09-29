import { useEffect, useMemo, useState } from 'react'
import { useMemberships } from './useMemberships'

interface ActiveStoreState {
  storeId: string | null
  isLoading: boolean
  error: string | null
}

const STORE_ERROR_MESSAGE = 'We could not load your workspace access. Some features may be limited.'

export function useActiveStore(): ActiveStoreState {
  const [persistedStoreId, setPersistedStoreId] = useState<string | null>(null)
  const [isPersistedLoading, setIsPersistedLoading] = useState(true)

  const normalizedPersistedStoreId =
    persistedStoreId && persistedStoreId.trim() !== '' ? persistedStoreId.trim() : null
  const membershipsHookStoreId = isPersistedLoading
    ? undefined
    : normalizedPersistedStoreId ?? null
  const {
    memberships,
    loading: membershipLoading,
    error,
  } = useMemberships(membershipsHookStoreId)

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsPersistedLoading(false)
      return
    }

    const storedId = window.localStorage.getItem('activeStoreId')
    setPersistedStoreId(storedId)
    setIsPersistedLoading(false)
  }, [])

  const membershipStoreId = memberships.find(m => m.storeId)?.storeId ?? null

  useEffect(() => {
    if (membershipLoading) {
      return
    }

    if (typeof window === 'undefined') {
      return
    }

    if (!membershipStoreId) {
      return
    }

    const trimmedPersistedStoreId =
      persistedStoreId && persistedStoreId.trim() !== ''
        ? persistedStoreId.trim()
        : null

    if (trimmedPersistedStoreId === membershipStoreId) {
      return
    }

    setPersistedStoreId(membershipStoreId)
    window.localStorage.setItem('activeStoreId', membershipStoreId)
  }, [membershipLoading, membershipStoreId, persistedStoreId])
  const activeStoreId = isPersistedLoading
    ? null
    : normalizedPersistedStoreId ?? membershipStoreId
  const hasError = error != null

  return useMemo(
    () => ({
      storeId: activeStoreId ?? null,
      isLoading: membershipLoading || isPersistedLoading,
      error: hasError ? STORE_ERROR_MESSAGE : null,
    }),
    [activeStoreId, hasError, isPersistedLoading, membershipLoading],
  )
}

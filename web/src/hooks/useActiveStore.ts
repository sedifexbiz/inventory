import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMemberships, type Membership } from './useMemberships'
import { useAuthUser } from './useAuthUser'
import {
  clearLegacyActiveStoreId,
  clearActiveStoreIdForUser,
  persistActiveStoreIdForUser,
  readActiveStoreId,
} from '../utils/activeStoreStorage'

interface ActiveStoreState {
  storeId: string | null
  isLoading: boolean
  error: string | null
  memberships: Membership[]
  membershipsLoading: boolean
  setActiveStoreId: (storeId: string | null) => void
  storeChangeToken: number
}

const STORE_ERROR_MESSAGE = 'We could not load your workspace access. Some features may be limited.'

export function useActiveStore(): ActiveStoreState {
  const user = useAuthUser()
  const uid = user?.uid ?? null

  const [persistedStoreId, setPersistedStoreId] = useState<string | null>(null)
  const [isPersistedLoading, setIsPersistedLoading] = useState(true)
  const [storeChangeToken, setStoreChangeToken] = useState(0)
  const previousStoreIdRef = useRef<string | null | undefined>(undefined)

  const normalizedPersistedStoreId =
    persistedStoreId && persistedStoreId.trim() !== '' ? persistedStoreId.trim() : null
  const membershipsHookStoreId = isPersistedLoading
    ? undefined
    : null
  const {
    memberships,
    loading: membershipLoading,
    error,
  } = useMemberships(membershipsHookStoreId)

  useEffect(() => {
    if (typeof window === 'undefined') {
      setPersistedStoreId(null)
      setIsPersistedLoading(false)
      return
    }

    setIsPersistedLoading(true)
    setPersistedStoreId(null)
    clearLegacyActiveStoreId()

    if (!uid) {
      setIsPersistedLoading(false)
      return
    }

    const storedId = readActiveStoreId(uid)
    setPersistedStoreId(storedId)
    setIsPersistedLoading(false)
  }, [uid])

  const membershipStoreIds = useMemo(
    () =>
      memberships
        .map(membership => membership.storeId)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    [memberships],
  )
  const membershipStoreId = membershipStoreIds[0] ?? null
  const isPersistedStoreValid = normalizedPersistedStoreId
    ? membershipStoreIds.includes(normalizedPersistedStoreId)
    : false

  useEffect(() => {
    if (membershipLoading) {
      return
    }

    if (typeof window === 'undefined' || !uid) {
      return
    }

    if (!memberships.length) {
      setPersistedStoreId(null)
      clearActiveStoreIdForUser(uid)
      return
    }

    if (!membershipStoreId) {
      return
    }

    const trimmedPersistedStoreId =
      persistedStoreId && persistedStoreId.trim() !== ''
        ? persistedStoreId.trim()
        : null

    if (trimmedPersistedStoreId && membershipStoreIds.includes(trimmedPersistedStoreId)) {
      return
    }

    setPersistedStoreId(membershipStoreId)
    persistActiveStoreIdForUser(uid, membershipStoreId)
  }, [
    membershipLoading,
    membershipStoreId,
    membershipStoreIds,
    memberships.length,
    persistedStoreId,
    uid,
  ])

  const activeStoreId = isPersistedLoading
    ? null
    : isPersistedStoreValid
      ? normalizedPersistedStoreId
      : membershipStoreId
  const hasError = error != null

  const setActiveStoreId = useCallback(
    (storeId: string | null) => {
      const normalized = storeId && storeId.trim() !== '' ? storeId.trim() : null

      if (normalized && !membershipStoreIds.includes(normalized)) {
        return
      }

      setPersistedStoreId(normalized)

      if (!uid) {
        return
      }

      if (normalized) {
        persistActiveStoreIdForUser(uid, normalized)
      } else {
        clearActiveStoreIdForUser(uid)
      }
    },
    [membershipStoreIds, uid],
  )

  useEffect(() => {
    if (previousStoreIdRef.current === activeStoreId) {
      return
    }

    previousStoreIdRef.current = activeStoreId ?? null
    setStoreChangeToken(token => token + 1)
  }, [activeStoreId])

  return useMemo(
    () => ({
      storeId: activeStoreId ?? null,
      isLoading: membershipLoading || isPersistedLoading,
      error: hasError ? STORE_ERROR_MESSAGE : null,
      memberships,
      membershipsLoading: membershipLoading,
      setActiveStoreId,
      storeChangeToken,
    }),
    [
      activeStoreId,
      hasError,
      isPersistedLoading,
      membershipLoading,
      memberships,
      setActiveStoreId,
      storeChangeToken,
    ],
  )
}

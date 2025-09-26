import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthUser } from './useAuthUser'

interface ActiveStoreState {
  storeId: string | null
  stores: string[]
  isLoading: boolean
  error: string | null
  selectStore: (storeId: string) => void
}

interface StoreClaims {
  stores?: unknown
  activeStoreId?: unknown
}

interface InternalStoreState {
  storeId: string | null
  stores: string[]
  isLoading: boolean
  error: string | null
}

const ACTIVE_STORE_STORAGE_PREFIX = 'sedifex.activeStore.'

function normalizeStoreList(claims: StoreClaims): string[] {
  if (!Array.isArray(claims.stores)) {
    return []
  }

  return claims.stores.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function getStorageKey(uid: string) {
  return `${ACTIVE_STORE_STORAGE_PREFIX}${uid}`
}

function readPersistedStoreId(uid: string | null): string | null {
  if (!uid || typeof window === 'undefined' || !window?.localStorage) {
    return null
  }

  try {
    const stored = window.localStorage.getItem(getStorageKey(uid))
    return typeof stored === 'string' && stored.trim().length > 0 ? stored : null
  } catch (error) {
    console.warn('[store] Failed to read persisted store preference', error)
    return null
  }
}

function persistStoreId(uid: string, storeId: string | null) {
  if (typeof window === 'undefined' || !window?.localStorage) {
    return
  }

  const key = getStorageKey(uid)
  try {
    if (storeId) {
      window.localStorage.setItem(key, storeId)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch (error) {
    console.warn('[store] Failed to persist store preference', error)
  }
}

function resolveStoreId(
  stores: string[],
  activeClaim: string | null,
  persistedStoreId: string | null,
  fallbackUid: string | null,
): string | null {
  if (activeClaim && stores.includes(activeClaim)) {
    return activeClaim
  }

  if (persistedStoreId && stores.includes(persistedStoreId)) {
    return persistedStoreId
  }

  if (stores.length > 0) {
    return stores[0]
  }

  return fallbackUid ?? null
}

export function useActiveStore(): ActiveStoreState {
  const user = useAuthUser()
  const [state, setState] = useState<InternalStoreState>({
    storeId: null,
    stores: [],
    isLoading: Boolean(user),
    error: null,
  })

  const selectStore = useCallback(
    (storeId: string) => {
      if (!user) {
        return
      }

      setState(prev => {
        if (!prev.stores.includes(storeId)) {
          return prev
        }

        persistStoreId(user.uid, storeId)
        return {
          ...prev,
          storeId,
        }
      })
    },
    [user],
  )

  useEffect(() => {
    let cancelled = false

    if (!user) {
      setState({ storeId: null, stores: [], isLoading: false, error: null })
      return
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }))

    const persistedStoreId = readPersistedStoreId(user.uid)

    user
      .getIdTokenResult()
      .then(result => {
        if (cancelled) return
        const claims: StoreClaims = result.claims as StoreClaims
        const stores = normalizeStoreList(claims)
        const activeClaim = typeof claims.activeStoreId === 'string' ? claims.activeStoreId : null
        const resolvedStoreId = resolveStoreId(stores, activeClaim, persistedStoreId, user.uid)

        if (resolvedStoreId && stores.includes(resolvedStoreId)) {
          persistStoreId(user.uid, resolvedStoreId)
        } else if (stores.length === 0) {
          persistStoreId(user.uid, null)
        }

        setState({
          storeId: resolvedStoreId,
          stores,
          isLoading: false,
          error: null,
        })
      })
      .catch(error => {
        console.warn('[store] Unable to resolve store from auth claims', error)
        if (cancelled) return
        setState({
          storeId: user.uid ?? null,
          stores: [],
          isLoading: false,
          error: 'We could not determine your store access. Some actions may fail.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [user])

  return useMemo(
    () => ({
      storeId: state.storeId,
      stores: state.stores,
      isLoading: state.isLoading,
      error: state.error,
      selectStore,
    }),
    [selectStore, state.error, state.isLoading, state.storeId, state.stores],
  )
}


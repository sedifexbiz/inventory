import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthUser } from './useAuthUser'

export type StoreRole = 'owner' | 'manager' | 'cashier' | string

type StoreRoleMap = Record<string, StoreRole>

interface ActiveStoreState {
  storeId: string | null
  role: StoreRole | null
  stores: string[]
  isLoading: boolean
  error: string | null
  selectStore: (storeId: string) => void
}

interface StoreClaims {
  stores?: unknown
  activeStoreId?: unknown
  roleByStore?: unknown
}

interface InternalStoreState {
  storeId: string | null
  role: StoreRole | null
  stores: string[]
  rolesByStore: StoreRoleMap
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

function normalizeRoleMap(claims: StoreClaims): StoreRoleMap {
  if (typeof claims.roleByStore !== 'object' || claims.roleByStore === null) {
    return {}
  }

  const roleEntries = Object.entries(claims.roleByStore as Record<string, unknown>)
  return roleEntries.reduce<StoreRoleMap>((acc, [storeId, value]) => {
    if (typeof value === 'string' && typeof storeId === 'string' && storeId.trim().length > 0) {
      acc[storeId] = value as StoreRole
    }
    return acc
  }, {})
}

function resolveRole(rolesByStore: StoreRoleMap, storeId: string | null): StoreRole | null {
  if (!storeId) {
    return null
  }

  return rolesByStore[storeId] ?? null
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
    role: null,
    stores: [],
    rolesByStore: {},
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
          role: resolveRole(prev.rolesByStore, storeId),
        }
      })
    },
    [user],
  )

  useEffect(() => {
    let cancelled = false

    if (!user) {
      setState({ storeId: null, role: null, stores: [], rolesByStore: {}, isLoading: false, error: null })
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
        const rolesByStore = normalizeRoleMap(claims)
        const activeClaim = typeof claims.activeStoreId === 'string' ? claims.activeStoreId : null
        const resolvedStoreId = resolveStoreId(stores, activeClaim, persistedStoreId, user.uid)
        const role = resolveRole(rolesByStore, resolvedStoreId)

        if (resolvedStoreId && stores.includes(resolvedStoreId)) {
          persistStoreId(user.uid, resolvedStoreId)
        } else if (stores.length === 0) {
          persistStoreId(user.uid, null)
        }

        setState({
          storeId: resolvedStoreId,
          role,
          stores,
          rolesByStore,
          isLoading: false,
          error: null,
        })
      })
      .catch(error => {
        console.warn('[store] Unable to resolve store from auth claims', error)
        if (cancelled) return
        setState({
          storeId: user.uid ?? null,
          role: null,
          stores: [],
          rolesByStore: {},
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
      role: state.role,
      stores: state.stores,
      isLoading: state.isLoading,
      error: state.error,
      selectStore,
    }),
    [selectStore, state.error, state.isLoading, state.role, state.storeId, state.stores],
  )
}


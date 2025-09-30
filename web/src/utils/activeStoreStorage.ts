const ACTIVE_STORE_STORAGE_PREFIX = 'activeStoreId:'
const LEGACY_ACTIVE_STORE_STORAGE_KEY = 'activeStoreId'

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

export function getActiveStoreStorageKey(uid: string): string {
  return `${ACTIVE_STORE_STORAGE_PREFIX}${uid}`
}

export function readActiveStoreId(uid: string | null | undefined): string | null {
  if (!uid || !hasWindow()) {
    return null
  }

  try {
    const value = window.localStorage.getItem(getActiveStoreStorageKey(uid))
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export function persistActiveStoreIdForUser(uid: string | null | undefined, storeId: string | null | undefined) {
  if (!uid || !storeId || !hasWindow()) {
    return
  }

  try {
    window.localStorage.setItem(getActiveStoreStorageKey(uid), storeId)
    window.localStorage.removeItem(LEGACY_ACTIVE_STORE_STORAGE_KEY)
  } catch {
    /* noop */
  }
}

export function clearActiveStoreIdForUser(uid: string | null | undefined) {
  if (!uid || !hasWindow()) {
    return
  }

  try {
    window.localStorage.removeItem(getActiveStoreStorageKey(uid))
  } catch {
    /* noop */
  }
}

export function clearLegacyActiveStoreId() {
  if (!hasWindow()) {
    return
  }

  try {
    window.localStorage.removeItem(LEGACY_ACTIVE_STORE_STORAGE_KEY)
  } catch {
    /* noop */
  }
}

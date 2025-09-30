const ACTIVE_STORE_STORAGE_PREFIX = 'activeStoreId:'
const LEGACY_ACTIVE_STORE_STORAGE_KEY = 'activeStoreId'

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function normalizeUid(uid: string | null | undefined): string | null {
  if (typeof uid !== 'string') {
    return null
  }
  const trimmed = uid.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeStoreId(storeId: string | null | undefined): string | null {
  if (typeof storeId !== 'string') {
    return null
  }
  const trimmed = storeId.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getActiveStoreStorageKey(uid: string): string {
  return `${ACTIVE_STORE_STORAGE_PREFIX}${uid}`
}

export function readActiveStoreId(uid: string | null | undefined): string | null {
  const normalizedUid = normalizeUid(uid)
  if (!normalizedUid || !hasWindow()) {
    return null
  }

  try {
    const value = window.localStorage.getItem(getActiveStoreStorageKey(normalizedUid))
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export function persistActiveStoreIdForUser(uid: string | null | undefined, storeId: string | null | undefined) {
  const normalizedUid = normalizeUid(uid)
  const normalizedStoreId = normalizeStoreId(storeId)
  if (!normalizedUid || !normalizedStoreId || !hasWindow()) {
    return
  }

  try {
    window.localStorage.setItem(getActiveStoreStorageKey(normalizedUid), normalizedStoreId)
    window.localStorage.removeItem(LEGACY_ACTIVE_STORE_STORAGE_KEY)
  } catch {
    /* noop */
  }
}

export function clearActiveStoreIdForUser(uid: string | null | undefined) {
  const normalizedUid = normalizeUid(uid)
  if (!normalizedUid || !hasWindow()) {
    return
  }

  try {
    window.localStorage.removeItem(getActiveStoreStorageKey(normalizedUid))
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

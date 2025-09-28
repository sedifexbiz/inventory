const DB_NAME = 'sedifex-offline-cache'
const DB_VERSION = 1
const STORE_NAME = 'lists'
const DEFAULT_PARTITION_KEY = '__global'

export const PRODUCT_CACHE_LIMIT = 200
export const CUSTOMER_CACHE_LIMIT = 200
export const SALES_CACHE_LIMIT = 500

type CacheEntry<T> = {
  key: string
  items: T[]
  savedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function isIndexedDbAvailable() {
  return typeof indexedDB !== 'undefined'
}

function openDatabase() {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'))
  }

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open offline cache database.'))
      }

      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => {
          database.close()
          dbPromise = null
        }
        resolve(database)
      }
    })
  }

  return dbPromise
}

function toMillis(value: unknown): number | null {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof value === 'object') {
    const anyValue = value as { toMillis?: () => number; seconds?: number; nanoseconds?: number }
    if (typeof anyValue.toMillis === 'function') {
      try {
        return anyValue.toMillis()
      } catch (error) {
        console.warn('[offlineCache] Failed to convert value via toMillis', error)
      }
    }
    if (typeof anyValue.seconds === 'number') {
      const millis = anyValue.seconds * 1000 + Math.round((anyValue.nanoseconds ?? 0) / 1_000_000)
      return Number.isFinite(millis) ? millis : null
    }
  }
  return null
}

function getFreshnessScore(item: unknown): number {
  if (!item || typeof item !== 'object') return 0
  const record = item as { updatedAt?: unknown; createdAt?: unknown }
  const updatedAt = toMillis(record.updatedAt)
  if (updatedAt !== null) return updatedAt
  const createdAt = toMillis(record.createdAt)
  if (createdAt !== null) return createdAt
  return 0
}

function sortAndTrim<T>(items: T[], limit: number) {
  if (limit <= 0) return [] as T[]
  return [...items]
    .sort((a, b) => getFreshnessScore(b) - getFreshnessScore(a))
    .slice(0, limit)
}

function resolvePartitionKey(baseKey: string, storeId?: string | null) {
  const normalized = typeof storeId === 'string' ? storeId.trim() : ''
  const suffix = normalized ? normalized : DEFAULT_PARTITION_KEY
  return `${baseKey}:${suffix}`
}

type CacheOptions = {
  limit?: number
  storeId?: string | null
}

async function loadCachedList<T>(key: string, limit: number): Promise<T[]> {
  if (!isIndexedDbAvailable()) return []
  try {
    const db = await openDatabase()
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key)
      request.onerror = () => reject(request.error ?? new Error('Failed to read cached list.'))
      request.onsuccess = () => {
        const entry = request.result as CacheEntry<T> | undefined
        resolve(entry ? sortAndTrim(entry.items ?? [], limit) : [])
      }
    })
  } catch (error) {
    console.warn('[offlineCache] Failed to load cache entry', error)
    return []
  }
}

async function saveCachedList<T>(key: string, items: T[], limit: number): Promise<void> {
  if (!isIndexedDbAvailable()) return
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const entry: CacheEntry<T> = {
        key,
        items: sortAndTrim(items, limit),
        savedAt: Date.now(),
      }
      const request = store.put(entry)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Failed to persist cached list.'))
    })
  } catch (error) {
    console.warn('[offlineCache] Failed to save cache entry', error)
  }
}

export async function loadCachedProducts<T extends { updatedAt?: unknown; createdAt?: unknown }>(
  options: CacheOptions = {},
): Promise<T[]> {
  const { limit = PRODUCT_CACHE_LIMIT, storeId } = options
  return loadCachedList<T>(resolvePartitionKey('products', storeId), limit)
}

export async function saveCachedProducts<T extends { updatedAt?: unknown; createdAt?: unknown }>(
  items: T[],
  options: CacheOptions = {},
): Promise<void> {
  const { limit = PRODUCT_CACHE_LIMIT, storeId } = options
  await saveCachedList(resolvePartitionKey('products', storeId), items, limit)
}

export async function loadCachedCustomers<T extends { updatedAt?: unknown; createdAt?: unknown }>(
  options: CacheOptions = {},
): Promise<T[]> {
  const { limit = CUSTOMER_CACHE_LIMIT, storeId } = options
  return loadCachedList<T>(resolvePartitionKey('customers', storeId), limit)
}

export async function saveCachedCustomers<T extends { updatedAt?: unknown; createdAt?: unknown }>(
  items: T[],
  options: CacheOptions = {},
): Promise<void> {
  const { limit = CUSTOMER_CACHE_LIMIT, storeId } = options
  await saveCachedList(resolvePartitionKey('customers', storeId), items, limit)
}

export async function loadCachedSales<T extends { createdAt?: unknown }>(
  options: CacheOptions = {},
): Promise<T[]> {
  const { limit = SALES_CACHE_LIMIT, storeId } = options
  return loadCachedList<T>(resolvePartitionKey('sales', storeId), limit)
}

export async function saveCachedSales<T extends { createdAt?: unknown }>(
  items: T[],
  options: CacheOptions = {},
): Promise<void> {
  const { limit = SALES_CACHE_LIMIT, storeId } = options
  await saveCachedList(resolvePartitionKey('sales', storeId), items, limit)
}

const CACHE_NAME = 'sedifex-static-v2'
const SYNC_TAG = 'sync-pending-requests'
const BASE_URL = new URL('./', self.location).pathname
const PRECACHE_URLS = [
  `${BASE_URL}index.html`,
  `${BASE_URL}manifest.webmanifest`,
  `${BASE_URL}heartbeat.json`,
]

const DB_NAME = 'sedifex-offline'
const DB_VERSION = 1
const STORE_NAME = 'pending'
const MAX_RETRIES = 3

let isProcessingQueue = false
let lastQueueStatus = 'idle'
let lastQueueError = null

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).catch(error => {
      console.warn('[sw] Precaching failed', error)
    })
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      await self.clients.claim()
      const keys = await caches.keys()
      await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
      await processQueue()
    })()
  )
})

const HEARTBEAT_PATH = `${BASE_URL}heartbeat.json`
const OFFLINE_FALLBACK = `${BASE_URL}index.html`

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (url.pathname === HEARTBEAT_PATH) {
    event.respondWith(
      fetch(new Request(request, { cache: 'no-store' }))
    )
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(OFFLINE_FALLBACK).then(cached => cached || fetch(request).catch(() => cached))
    )
    return
  }

  if (url.origin !== self.location.origin) {
    return
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const fetchPromise = fetch(request)
        .then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response
          }
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          return response
        })
        .catch(() => cached)

      return cached || fetchPromise
    })
  )
})

self.addEventListener('message', event => {
  const data = event.data
  if (!data || typeof data !== 'object') return

  if (data.type === 'QUEUE_BACKGROUND_REQUEST' && data.payload) {
    event.waitUntil(handleQueueRequest(data.payload))
  }

  if (data.type === 'PROCESS_QUEUE_NOW') {
    event.waitUntil(processQueue())
  }

  if (data.type === 'REQUEST_QUEUE_STATUS') {
    event.waitUntil(respondQueueStatus(event.source))
  }
})

self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(processQueue())
  }
})

async function handleQueueRequest(payload) {
  const entry = {
    requestType: payload.requestType,
    endpoint: payload.endpoint,
    payload: payload.payload,
    authToken: payload.authToken || null,
    createdAt: payload.createdAt || Date.now(),
    retries: 0,
    updatedAt: Date.now(),
  }

  await addQueueEntry(entry)
  await scheduleSync()
  await broadcastQueueState(isProcessingQueue ? 'processing' : 'pending')
}

async function scheduleSync() {
  if (self.registration && 'sync' in self.registration) {
    try {
      await self.registration.sync.register(SYNC_TAG)
    } catch (error) {
      console.warn('[sw] Unable to register background sync', error)
      await processQueue()
    }
  } else {
    await processQueue()
  }
}

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function addQueueEntry(entry) {
  const db = await openQueueDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => {
      db.close()
      resolve(true)
    }
    tx.onabort = tx.onerror = () => {
      const error = tx.error || new Error('Queue transaction failed')
      db.close()
      reject(error)
    }
    tx.objectStore(STORE_NAME).add(entry)
  })
}

async function getQueueEntries() {
  const db = await openQueueDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    request.onsuccess = () => {
      db.close()
      resolve(request.result || [])
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

async function getQueueCount() {
  const db = await openQueueDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.count()
    request.onsuccess = () => {
      db.close()
      resolve(request.result || 0)
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

async function deleteQueueEntry(id) {
  const db = await openQueueDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => {
      db.close()
      resolve(true)
    }
    tx.onabort = tx.onerror = () => {
      const error = tx.error || new Error('Queue delete failed')
      db.close()
      reject(error)
    }
    tx.objectStore(STORE_NAME).delete(id)
  })
}

async function updateQueueEntry(id, updates) {
  const db = await openQueueDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get(id)
    getRequest.onsuccess = () => {
      const current = getRequest.result
      if (!current) {
        resolve(false)
        return
      }
      const next = Object.assign({}, current, updates)
      store.put(next)
    }
    tx.oncomplete = () => {
      db.close()
      resolve(true)
    }
    tx.onabort = tx.onerror = () => {
      const error = tx.error || new Error('Queue update failed')
      db.close()
      reject(error)
    }
  })
}

async function processQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true
  try {
    const entries = await getQueueEntries()
    if (!entries.length) {
      await broadcastQueueState('idle', { pending: 0 })
      return
    }

    await broadcastQueueState('processing', { pending: entries.length })

    const failures = []
    let lastFailureMessage = null

    for (const entry of entries) {
      if (!entry || entry.id === undefined) continue
      try {
        await sendQueueEntry(entry)
        await deleteQueueEntry(entry.id)
        notifyClients({ type: 'QUEUE_REQUEST_COMPLETED', requestType: entry.requestType })
      } catch (error) {
        console.warn('[sw] Failed to send queued request', error)
        const attempts = (entry.retries || 0) + 1
        if (attempts >= MAX_RETRIES) {
          await deleteQueueEntry(entry.id)
          notifyClients({
            type: 'QUEUE_REQUEST_FAILED',
            requestType: entry.requestType,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        } else {
          await updateQueueEntry(entry.id, { retries: attempts, updatedAt: Date.now() })
          failures.push(entry.id)
          lastFailureMessage = error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }

    const pending = await getQueueCount()

    if (failures.length) {
      await broadcastQueueState('error', {
        pending,
        error: lastFailureMessage || 'Some queued requests failed',
      })
      notifyClients({ type: 'QUEUE_PROCESSING_REQUIRED' })
      if (self.registration && 'sync' in self.registration) {
        try {
          await self.registration.sync.register(SYNC_TAG)
        } catch (error) {
          console.warn('[sw] Unable to re-register sync after failure', error)
        }
      }
    } else if (pending > 0) {
      await broadcastQueueState('pending', { pending })
    } else {
      await broadcastQueueState('idle', { pending })
    }
  } catch (error) {
    console.warn('[sw] Queue processing failed', error)
    const pending = await getQueueCount().catch(() => 0)
    await broadcastQueueState('error', {
      pending,
      error: error instanceof Error ? error.message : 'Queue processing failed',
    })
    throw error
  } finally {
    isProcessingQueue = false
  }
}

async function sendQueueEntry(entry) {
  const headers = { 'Content-Type': 'application/json' }
  if (entry.authToken) {
    headers['Authorization'] = `Bearer ${entry.authToken}`
  }

  const response = await fetch(entry.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: entry.payload }),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const result = await response.json().catch(() => ({}))
  if (result && result.error) {
    throw new Error(result.error.message || 'Callable function error')
  }
  return result
}

function notifyClients(message) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      clients.forEach(client => {
        client.postMessage(message)
      })
    })
    .catch(error => {
      console.warn('[sw] Unable to notify clients', error)
    })
}

async function broadcastQueueState(status, details = {}, target) {
  let pending = typeof details.pending === 'number' ? details.pending : await getQueueCount().catch(() => 0)
  if (pending <= 0 && status !== 'error') {
    pending = 0
    status = 'idle'
  }

  if (status === 'error') {
    lastQueueError = typeof details.error === 'string' ? details.error : lastQueueError || 'Queue processing failed'
  }

  if (status === 'idle') {
    lastQueueError = null
  }

  lastQueueStatus = status

  const message = { type: 'QUEUE_STATUS', status, pending }
  if (status === 'error' && lastQueueError) {
    message.error = lastQueueError
  }

  if (target && typeof target.postMessage === 'function') {
    target.postMessage(message)
    return
  }

  await notifyClients(message)
}

async function respondQueueStatus(target) {
  let status = lastQueueStatus
  let error = lastQueueError

  if (isProcessingQueue) {
    status = 'processing'
  }

  let pending = await getQueueCount().catch(() => 0)
  if (pending <= 0 && status !== 'error') {
    pending = 0
    status = 'idle'
    error = null
  }

  const message = { type: 'QUEUE_STATUS', status, pending }
  if (status === 'error' && error) {
    message.error = error
  }

  if (target && typeof target.postMessage === 'function') {
    target.postMessage(message)
    return
  }

  await notifyClients(message)
}

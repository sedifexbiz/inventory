import { triggerQueueProcessing } from './utils/offlineQueue'

// Simple service worker registration with offline queue support hooks
if ('serviceWorker' in navigator) {
  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`

  window.addEventListener('load', () => {
    const swUrl = `${baseUrl}sw.js`
    navigator.serviceWorker.register(swUrl, { scope: baseUrl })
  })

  window.addEventListener('online', () => {
    triggerQueueProcessing()
  })

  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data
    if (!data || typeof data !== 'object') return

    if (data.type === 'QUEUE_PROCESSING_REQUIRED' && navigator.onLine) {
      triggerQueueProcessing()
    }
  })
}

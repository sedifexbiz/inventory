import '@testing-library/jest-dom/vitest'

vi.stubEnv('VITE_FB_API_KEY', 'test-api-key')
vi.stubEnv('VITE_FB_AUTH_DOMAIN', 'sedifex.test.local')
vi.stubEnv('VITE_FB_PROJECT_ID', 'sedifex-test')
vi.stubEnv('VITE_FB_STORAGE_BUCKET', 'sedifex-test.appspot.com')
vi.stubEnv('VITE_FB_APP_ID', '1:1234567890:web:test')
vi.stubEnv('VITE_FB_FUNCTIONS_REGION', 'us-central1')

beforeEach(() => {
  // Ensure print is stubbed so tests can observe invocations without touching the real browser API.
  Object.defineProperty(window, 'print', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
})

import { initializeApp } from 'firebase/app'
import { getAuth, RecaptchaVerifier } from 'firebase/auth'
import { initializeFirestore, enableIndexedDbPersistence } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'
import { getStorage } from 'firebase/storage'

type FirebaseEnvKey =
  | 'VITE_FB_API_KEY'
  | 'VITE_FB_AUTH_DOMAIN'
  | 'VITE_FB_PROJECT_ID'
  | 'VITE_FB_STORAGE_BUCKET'
  | 'VITE_FB_APP_ID'

function requireFirebaseEnv(key: FirebaseEnvKey): string {
  const value = import.meta.env[key]
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }

  throw new Error(
    `[firebase] Missing required environment variable "${key}". ` +
      'Ensure the value is defined in your deployment configuration.'
  )
}

const firebaseConfig = {
  apiKey: requireFirebaseEnv('VITE_FB_API_KEY'),
  authDomain: requireFirebaseEnv('VITE_FB_AUTH_DOMAIN'),
  projectId: requireFirebaseEnv('VITE_FB_PROJECT_ID'),
  storageBucket: requireFirebaseEnv('VITE_FB_STORAGE_BUCKET'),
  appId: requireFirebaseEnv('VITE_FB_APP_ID'),
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

export const db = initializeFirestore(app, { ignoreUndefinedProperties: true })
enableIndexedDbPersistence(db).catch(() => {/* multi-tab fallback handled */})

export const storage = getStorage(app)
export const functions = getFunctions(app)

export function setupRecaptcha(containerId = 'recaptcha-container') {
  return new RecaptchaVerifier(auth, containerId, { size: 'invisible' })
}

const requiredEnvKeys = [
  'VITE_FB_API_KEY',
  'VITE_FB_AUTH_DOMAIN',
  'VITE_FB_PROJECT_ID',
  'VITE_FB_STORAGE_BUCKET',
  'VITE_FB_APP_ID',
] as const

type RequiredFirebaseEnvKey = (typeof requiredEnvKeys)[number]

type FirebaseEnvConfig = {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  appId: string
  functionsRegion: string
}

function getRequiredEnv(key: RequiredFirebaseEnvKey): string {
  const value = import.meta.env[key]
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }

  throw new Error(
    `[firebase-env] Missing required environment variable "${key}". ` +
      'Ensure this value is provided in your deployment configuration.'
  )
}

function getOptionalEnv(key: string, fallback: string): string {
  const value = import.meta.env[key]
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }

  return fallback
}

export const firebaseEnv: FirebaseEnvConfig = {
  apiKey: getRequiredEnv('VITE_FB_API_KEY'),
  authDomain: getRequiredEnv('VITE_FB_AUTH_DOMAIN'),
  projectId: getRequiredEnv('VITE_FB_PROJECT_ID'),
  storageBucket: getRequiredEnv('VITE_FB_STORAGE_BUCKET'),
  appId: getRequiredEnv('VITE_FB_APP_ID'),
  functionsRegion: getOptionalEnv('VITE_FB_FUNCTIONS_REGION', 'us-central1'),
}

export type { FirebaseEnvConfig }

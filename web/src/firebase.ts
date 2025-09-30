import { initializeApp } from 'firebase/app'
import { getAuth, RecaptchaVerifier } from 'firebase/auth'
import {
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'
import { getStorage } from 'firebase/storage'

import { firebaseEnv } from './config/firebaseEnv'

const firebaseConfig = {
  apiKey: firebaseEnv.apiKey,
  authDomain: firebaseEnv.authDomain,
  projectId: firebaseEnv.projectId,
  storageBucket: firebaseEnv.storageBucket,
  appId: firebaseEnv.appId,
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

let firestoreSettings: Parameters<typeof initializeFirestore>[1]

try {
  firestoreSettings = {
    ignoreUndefinedProperties: true,
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  }
} catch (error) {
  console.warn(
    '[firebase] Falling back to in-memory Firestore cache:',
    error
  )
  firestoreSettings = {
    ignoreUndefinedProperties: true,
    localCache: memoryLocalCache(),
  }
}

export const db = initializeFirestore(app, firestoreSettings)

export const storage = getStorage(app)
export const functions = getFunctions(app)

export function setupRecaptcha(containerId = 'recaptcha-container') {
  return new RecaptchaVerifier(auth, containerId, { size: 'invisible' })
}

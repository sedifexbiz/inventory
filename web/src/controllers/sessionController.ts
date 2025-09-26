import { Auth, User, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence, setPersistence } from 'firebase/auth'
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'

const SESSION_COOKIE = 'sedifex_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90 // 90 days

export async function configureAuthPersistence(auth: Auth) {
  try {
    await setPersistence(auth, browserLocalPersistence)
    return
  } catch (error) {
    console.warn('[auth] Falling back from local persistence', error)
  }

  try {
    await setPersistence(auth, browserSessionPersistence)
  } catch (error) {
    console.warn('[auth] Falling back to in-memory persistence', error)
    await setPersistence(auth, inMemoryPersistence)
  }
}

export async function persistSession(user: User) {
  const sessionId = ensureSessionId()
  try {
    await setDoc(
      doc(db, 'sessions', sessionId),
      {
        uid: user.uid,
        email: user.email ?? null,
        displayName: user.displayName ?? null,
        lastLoginAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null
      },
      { merge: true }
    )
  } catch (error) {
    console.warn('[session] Failed to persist session metadata', error)
  }
}

export async function refreshSessionHeartbeat(user: User) {
  const sessionId = getSessionId()
  if (!sessionId) {
    return
  }

  try {
    await updateDoc(doc(db, 'sessions', sessionId), {
      uid: user.uid,
      lastActiveAt: serverTimestamp()
    })
  } catch (error) {
    console.warn('[session] Failed to refresh session metadata', error)
    await persistSession(user)
  }
}

function ensureSessionId() {
  const existing = getSessionId()
  if (existing) {
    return existing
  }
  const generated = generateSessionId()
  setSessionCookie(generated)
  return generated
}

function getSessionId() {
  if (typeof document === 'undefined') {
    return null
  }
  const match = document.cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function setSessionCookie(value: string) {
  if (typeof document === 'undefined') {
    return
  }
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`
}

function generateSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

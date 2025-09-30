// web/src/App.tsx
import React, { useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { auth, db } from './firebase'
import './App.css'
import './pwa'
import { useToast } from './components/ToastProvider'
import {
  configureAuthPersistence,
  persistSession,
  refreshSessionHeartbeat,
} from './controllers/sessionController'
import { afterSignupBootstrap } from './controllers/accessController'
import { AuthUserContext } from './hooks/useAuthUser'
import {
  clearActiveStoreIdForUser,
  clearLegacyActiveStoreId,
  persistActiveStoreIdForUser,
} from './utils/activeStoreStorage'
import { getOnboardingStatus, setOnboardingStatus } from './utils/onboarding'
import type { QueueRequestType } from './utils/offlineQueue'

/* ------------------------------ config ------------------------------ */
/** If you want to ALSO mirror the team member to a fixed doc id, put it here. */
const OVERRIDE_MEMBER_DOC_ID = 'l8Rbmym8aBVMwL6NpZHntjBHmCo2' // set '' to disable

/* ------------------------------ constants ------------------------------ */

type AuthMode = 'login' | 'signup'
type StatusTone = 'idle' | 'loading' | 'success' | 'error'
interface StatusState { tone: StatusTone; message: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_MIN_LENGTH = 8
const LOGIN_IMAGE_URL = 'https://i.imgur.com/fx9vne9.jpeg'
const OWNER_NAME_FALLBACK = 'Owner account'
const DEFAULT_COUNTRY_CODE = '+1'
const COUNTRY_OPTIONS = [
  { code: '+1', label: 'United States / Canada (+1)' },
  { code: '+44', label: 'United Kingdom (+44)' },
  { code: '+234', label: 'Nigeria (+234)' },
  { code: '+61', label: 'Australia (+61)' },
  { code: '+91', label: 'India (+91)' },
  { code: '+65', label: 'Singapore (+65)' },
] as const

/* ------------------------------ helpers ------------------------------ */

type PhoneComposition = {
  countryCode: string
  localNumber: string
  e164: string
}

function composePhoneNumber(countryCode: string, localNumber: string): PhoneComposition {
  const trimmedCountry = (countryCode || '').trim()
  const trimmedLocal = (localNumber || '').trim()

  let normalizedCountry = trimmedCountry.replace(/^00/, '+').replace(/[^+\d]/g, '')
  if (normalizedCountry && !normalizedCountry.startsWith('+')) {
    normalizedCountry = `+${normalizedCountry.replace(/^\++/, '')}`
  }
  if (normalizedCountry === '+') {
    normalizedCountry = ''
  }

  const normalizedLocal = trimmedLocal.replace(/\D+/g, '')
  const e164 = normalizedCountry && normalizedLocal ? `${normalizedCountry}${normalizedLocal}` : ''

  return {
    countryCode: normalizedCountry,
    localNumber: normalizedLocal,
    e164,
  }
}
function persistActiveStoreId(storeId: string, uid: string) {
  persistActiveStoreIdForUser(uid, storeId)
}
function resolveOwnerName(user: User): string {
  const displayName = user.displayName?.trim()
  return displayName && displayName.length > 0 ? displayName : OWNER_NAME_FALLBACK
}
function generateStoreId(uid: string) {
  return `store-${uid.slice(0, 8)}`
}

/** Ensure teamMembers/{uid} exists; optionally mirror to fixed ID. */
async function upsertTeamMemberDocs(params: {
  user: User
  role: 'owner' | 'staff'
  phone?: string | null
  phoneCountryCode?: string | null
  phoneLocalNumber?: string | null
  company?: string | null
  preferExisting?: boolean
}) {
  const {
    user,
    role,
    phone = null,
    phoneCountryCode = null,
    phoneLocalNumber = null,
    company = null,
    preferExisting = true,
  } = params
  const uidRef = doc(db, 'teamMembers', user.uid)
  const lastSeenAt = serverTimestamp()

  // Try to reuse existing storeId if present
  if (preferExisting) {
    const snap = await getDoc(uidRef)
    if (snap.exists()) {
      const existingStoreId = String(snap.get('storeId') || '')
      if (existingStoreId) {
        await setDoc(uidRef, { lastSeenAt }, { merge: true })
        persistActiveStoreId(existingStoreId, user.uid)
        // Optionally mirror to fixed doc for your analytics/admin
        if (OVERRIDE_MEMBER_DOC_ID) {
          await setDoc(
            doc(db, 'teamMembers', OVERRIDE_MEMBER_DOC_ID),
            { ...snap.data(), lastSeenAt, updatedAt: serverTimestamp() },
            { merge: true },
          )
        }
        return { storeId: existingStoreId, role: (snap.get('role') as 'owner' | 'staff') || role }
      }
    }
  }

  const storeId = generateStoreId(user.uid)
  const timestamp = serverTimestamp()
  const payload = {
    uid: user.uid,
    email: user.email ?? null,
    phone,
    phoneCountryCode,
    phoneLocalNumber,
    role,
    company: company ?? null,
    storeId,
    name: resolveOwnerName(user),
    firstSignupEmail: (user.email ?? '').toLowerCase() || null,
    invitedBy: user.uid,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt,
  }

  await setDoc(uidRef, payload, { merge: true })

  if (OVERRIDE_MEMBER_DOC_ID) {
    await setDoc(doc(db, 'teamMembers', OVERRIDE_MEMBER_DOC_ID), payload, { merge: true })
  }

  persistActiveStoreId(storeId, user.uid)
  return { storeId, role }
}

/** Optional seed helper kept for future use */
type SeededDocument = { id: string; data: Record<string, unknown> }
const TIMESTAMP_FIELD_KEYS = new Set(['createdAt', 'updatedAt', 'receivedAt'])
function normalizeSeededDocumentData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  Object.entries(data).forEach(([key, value]) => {
    if (value === undefined) return
    if (value === null) { result[key] = null; return }
    if (TIMESTAMP_FIELD_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Timestamp.fromMillis(value); return
    }
    if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? normalizeSeededDocumentData(item as Record<string, unknown>)
          : item)
      return
    }
    if (typeof value === 'object') {
      result[key] = normalizeSeededDocumentData(value as Record<string, unknown>); return
    }
    result[key] = value
  })
  return result
}

/* ----------------------------- validation ----------------------------- */

interface PasswordStrength {
  isLongEnough: boolean
  hasUppercase: boolean
  hasLowercase: boolean
  hasNumber: boolean
  hasSymbol: boolean
}
function evaluatePasswordStrength(password: string): PasswordStrength {
  return {
    isLongEnough: password.length >= PASSWORD_MIN_LENGTH,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasNumber: /\d/.test(password),
    hasSymbol: /[^A-Za-z0-9]/.test(password),
  }
}
function getLoginValidationError(email: string, password: string): string | null {
  if (!email) return 'Enter your email.'
  if (!EMAIL_PATTERN.test(email)) return 'Enter a valid email address.'
  if (!password) return 'Enter your password.'
  return null
}
function getSignupValidationError(email: string, password: string, confirmPassword: string, phone: string, company: string): string | null {
  if (!email) return 'Enter your email.'
  if (!EMAIL_PATTERN.test(email)) return 'Enter a valid email address.'
  if (!password) return 'Create a password to continue.'
  const s = evaluatePasswordStrength(password)
  if (!s.isLongEnough) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  if (!s.hasUppercase) return 'Password must include an uppercase letter.'
  if (!s.hasLowercase) return 'Password must include a lowercase letter.'
  if (!s.hasNumber) return 'Password must include a number.'
  if (!s.hasSymbol) return 'Password must include a symbol.'
  if (!confirmPassword) return 'Confirm your password.'
  if (password !== confirmPassword) return 'Passwords do not match.'
  if (!phone) return 'Enter your phone number.'
  if (!company.trim()) return 'Enter your company name.'
  return null
}

/* ----------------------------- UI helpers ----------------------------- */

type QueueCompletedMessage = { type: 'QUEUE_REQUEST_COMPLETED'; requestType?: unknown }
type QueueFailedMessage = { type: 'QUEUE_REQUEST_FAILED'; requestType?: unknown; error?: unknown }
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null }
function isQueueCompletedMessage(v: unknown): v is QueueCompletedMessage { return isRecord(v) && (v as any).type === 'QUEUE_REQUEST_COMPLETED' }
function isQueueFailedMessage(v: unknown): v is QueueFailedMessage { return isRecord(v) && (v as any).type === 'QUEUE_REQUEST_FAILED' }
function getQueueRequestLabel(requestType: unknown): string { return requestType === 'receipt' ? 'stock receipt' : 'sale' }
function normalizeQueueError(v: unknown): string | null { if (typeof v === 'string') { const t = v.trim(); if (t) return t } return null }

/* --------------------------------- App --------------------------------- */

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const previousUidRef = useRef<string | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(false)

  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // new fields
  const [role, setRole] = useState<'owner' | 'staff'>('staff')
  const [company, setCompany] = useState('')

  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE)
  const [phone, setPhone] = useState('')
  const [normalizedPhone, setNormalizedPhone] = useState('')

  const [status, setStatus] = useState<StatusState>({ tone: 'idle', message: '' })
  const isLoading = status.tone === 'loading'
  const { publish } = useToast()
  const navigate = useNavigate()
  const location = useLocation()

  const normalizedEmail = email.trim()
  const normalizedPassword = password.trim()
  const normalizedConfirmPassword = confirmPassword.trim()
  const normalizedCompany = company.trim()

  const strength = evaluatePasswordStrength(normalizedPassword)
  const checklist = [
    { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, passed: strength.isLongEnough },
    { id: 'uppercase', label: 'Includes an uppercase letter', passed: strength.hasUppercase },
    { id: 'lowercase', label: 'Includes a lowercase letter', passed: strength.hasLowercase },
    { id: 'number', label: 'Includes a number', passed: strength.hasNumber },
    { id: 'symbol', label: 'Includes a symbol', passed: strength.hasSymbol },
  ] as const
  const meetsAll = checklist.every(c => c.passed)

  const isSignupFormValid =
    EMAIL_PATTERN.test(normalizedEmail) &&
    normalizedPassword.length > 0 &&
    meetsAll &&
    normalizedConfirmPassword.length > 0 &&
    normalizedPassword === normalizedConfirmPassword &&
    normalizedPhone.length > 0 &&
    normalizedCompany.length > 0

  const isLoginFormValid =
    EMAIL_PATTERN.test(normalizedEmail) && normalizedPassword.length > 0

  const isSubmitDisabled = isLoading || (mode === 'login' ? !isLoginFormValid : !isSignupFormValid)

  /* auth lifecycle */
  useEffect(() => {
    configureAuthPersistence(auth).catch(() => {})
    const unsubscribe = onAuthStateChanged(auth, nextUser => {
      const previousUid = previousUidRef.current

      if (!nextUser) {
        if (previousUid) {
          clearActiveStoreIdForUser(previousUid)
        }
        clearLegacyActiveStoreId()
      } else if (previousUid && previousUid !== nextUser.uid) {
        clearActiveStoreIdForUser(previousUid)
      }

      previousUidRef.current = nextUser?.uid ?? null
      setUser(nextUser)
      setIsAuthReady(true)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!user) return
    refreshSessionHeartbeat(user).catch(() => {})
  }, [user])

  useEffect(() => {
    if (!user) return
    const status = getOnboardingStatus(user.uid)
    if (status === 'pending' && location.pathname !== '/onboarding') {
      navigate('/onboarding', { replace: true })
    }
  }, [location.pathname, navigate, user])

  useEffect(() => {
    document.title = mode === 'login' ? 'Sedifex — Log in' : 'Sedifex — Sign up'
  }, [mode])

  /* sw queue notifications */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const handleMessage = (event: MessageEvent) => {
      const data = event.data
      if (!isRecord(data)) return
      if (isQueueCompletedMessage(data)) {
        const label = getQueueRequestLabel((data as any).requestType)
        publish({ message: `Queued ${label} synced successfully.`, tone: 'success' })
        return
      }
      if (isQueueFailedMessage(data)) {
        const label = getQueueRequestLabel((data as any).requestType)
        const detail = normalizeQueueError((data as any).error)
        publish({
          message: detail ? `We couldn't sync the queued ${label}. ${detail}` : `We couldn't sync the queued ${label}. Please try again.`,
          tone: 'error',
          duration: 8000,
        })
      }
    }
    navigator.serviceWorker.addEventListener('message', handleMessage)
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage)
  }, [publish])

  async function persistOwnerSideDocs(nextUser: User, storeId: string, phone: PhoneComposition) {
    // Optional: create a matching customers record
    try {
      const preferredDisplayName = nextUser.displayName?.trim() || (nextUser.email ?? '')
      await setDoc(
        doc(db, 'customers', nextUser.uid),
        {
          storeId,
          name: preferredDisplayName,
          displayName: preferredDisplayName,
          email: (nextUser.email ?? '').toLowerCase(),
          phone: phone.e164 || null,
          phoneCountryCode: phone.countryCode || null,
          phoneLocalNumber: phone.localNumber || null,
          status: 'active',
          role: 'client',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      )
    } catch (error) {
      console.warn('[customers] Unable to upsert customer record', error)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const sanitizedEmail = email.trim()
    const sanitizedPassword = password.trim()
    const sanitizedConfirmPassword = confirmPassword.trim()
    const phoneDetails = composePhoneNumber(countryCode, phone)
    const sanitizedPhone = phoneDetails.e164
    const sanitizedCompany = company.trim()

    setEmail(sanitizedEmail)
    setPassword(sanitizedPassword)
    if (mode === 'signup') setConfirmPassword(sanitizedConfirmPassword)

    const validationError =
      mode === 'login'
        ? getLoginValidationError(sanitizedEmail, sanitizedPassword)
        : getSignupValidationError(sanitizedEmail, sanitizedPassword, sanitizedConfirmPassword, sanitizedPhone, sanitizedCompany)

    if (mode === 'signup') {
      setCountryCode(phoneDetails.countryCode || DEFAULT_COUNTRY_CODE)
      setPhone(phoneDetails.localNumber)
      setNormalizedPhone(sanitizedPhone)
      if (!sanitizedPhone) {
        setStatus({ tone: 'error', message: 'Enter your phone number.' })
        return
      }
    }

    if (validationError) {
      setStatus({ tone: 'error', message: validationError })
      return
    }

    setStatus({ tone: 'loading', message: mode === 'login' ? 'Signing you in…' : 'Creating your account…' })

    try {
      if (mode === 'login') {
        const { user: nextUser } = await signInWithEmailAndPassword(auth, sanitizedEmail, sanitizedPassword)
        await persistSession(nextUser)

        // Load or create team member doc (no sheet involved)
        await upsertTeamMemberDocs({
          user: nextUser,
          role: 'owner', // fallback if missing — real role stored in Firestore
          preferExisting: true,
        })

      } else {
        const { user: nextUser } = await createUserWithEmailAndPassword(auth, sanitizedEmail, sanitizedPassword)
        await persistSession(nextUser)

        // Create team member with selected role + company; auto storeId
        const { storeId } = await upsertTeamMemberDocs({
          user: nextUser,
          role,
          company: sanitizedCompany,
          phone: sanitizedPhone,
          phoneCountryCode: phoneDetails.countryCode || null,
          phoneLocalNumber: phoneDetails.localNumber || null,
          preferExisting: false,
        })

        const ownerName = resolveOwnerName(nextUser)
        await afterSignupBootstrap({
          storeId,
          contact: {
            phone: sanitizedPhone || null,
            phoneCountryCode: phoneDetails.countryCode || null,
            phoneLocalNumber: phoneDetails.localNumber || null,
            firstSignupEmail: (nextUser.email ?? '').toLowerCase() || null,
            company: sanitizedCompany || null,
            ownerName,
          },
        })

        // Optional additional doc for UX
        await persistOwnerSideDocs(nextUser, storeId, phoneDetails)

        await afterSignupBootstrap(storeId)

        try { await nextUser.getIdToken(true) } catch {}
        setOnboardingStatus(nextUser.uid, 'pending')
      }

      setStatus({
        tone: 'success',
        message: mode === 'login' ? 'Welcome back! Redirecting…' : 'All set! Your account is ready.',
      })
      setPassword('')
      setConfirmPassword('')
      setPhone('')
      setCompany('')
      setNormalizedPhone('')
      setCountryCode(DEFAULT_COUNTRY_CODE)

    } catch (err: unknown) {
      setStatus({ tone: 'error', message: getErrorMessage(err) })
    }
  }

  useEffect(() => {
    if (!status.message) return
    if (status.tone === 'success' || status.tone === 'error') {
      publish({ tone: status.tone, message: status.message })
    }
  }, [publish, status.message, status.tone])

  function handleModeChange(nextMode: AuthMode) {
    setMode(nextMode)
    setStatus({ tone: 'idle', message: '' })
    setConfirmPassword('')
    setPhone('')
    setCompany('')
    setNormalizedPhone('')
    setCountryCode(DEFAULT_COUNTRY_CODE)
  }

  const appStyle: React.CSSProperties = { minHeight: '100dvh' }

  if (!isAuthReady) {
    return (
      <main className="app" style={appStyle}>
        <div className="app__card">
          <p className="form__hint">Checking your session…</p>
        </div>
      </main>
    )
  }

  if (!user) {
    const isSignup = mode === 'signup'
    return (
      <main className="app" style={appStyle}>
        <div className="app__layout">
          <div className="app__card">
            <div className="app__brand">
              <span className="app__logo">Sx</span>
              <div>
                <h1 className="app__title">Sedifex</h1>
                <p className="app__tagline">Sell faster. <span className="app__highlight">Count smarter.</span></p>
              </div>
            </div>

            <div className="app__pill-group" role="list">
              <span className="app__pill" role="listitem">Realtime visibility</span>
              <span className="app__pill" role="listitem">Multi-location ready</span>
              <span className="app__pill" role="listitem">Floor-friendly UI</span>
            </div>

            <p className="form__hint">
              {isSignup
                ? 'Create an account to start tracking sales and inventory in minutes.'
                : 'Welcome back! Sign in to keep your stock moving.'}
            </p>

            <div className="toggle-group" role="tablist" aria-label="Authentication mode">
              <button
                type="button"
                role="tab"
                aria-selected={!isSignup}
                className={`toggle-button${!isSignup ? ' is-active' : ''}`}
                onClick={() => handleModeChange('login')}
                disabled={isLoading}
              >
                Log in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isSignup}
                className={`toggle-button${isSignup ? ' is-active' : ''}`}
                onClick={() => handleModeChange('signup')}
                disabled={isLoading}
              >
                Sign up
              </button>
            </div>

            <form className="form" onSubmit={handleSubmit} aria-busy={isLoading} noValidate>
              <div className="form__field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onBlur={() => setEmail(current => current.trim())}
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                  disabled={isLoading}
                  inputMode="email"
                  aria-invalid={email.length > 0 && !EMAIL_PATTERN.test(normalizedEmail)}
                />
              </div>

              {isSignup && (
                <>
                  <div className="form__field">
                    <label htmlFor="role">Role</label>
                    <select
                      id="role"
                      value={role}
                      onChange={e => setRole(e.target.value as 'owner' | 'staff')}
                      disabled={isLoading}
                    >
                      <option value="owner">Owner</option>
                      <option value="staff">Staff</option>
                    </select>
                    <p className="form__hint">We’ll use this to set your workspace permissions.</p>
                  </div>

                  <div className="form__field">
                    <label htmlFor="company">Company</label>
                    <input
                      id="company"
                      value={company}
                      onChange={e => setCompany(e.target.value)}
                      onBlur={() => setCompany(current => current.trim())}
                      type="text"
                      autoComplete="organization"
                      placeholder="Acme Retail"
                      required
                      disabled={isLoading}
                      aria-invalid={company.length > 0 && !normalizedCompany}
                    />
                  </div>

                  <div className="form__field">
                    <label htmlFor="phone">Phone</label>
                    <div className="form__phone-row">
                      <div className="form__phone-country">
                        <label className="visually-hidden" htmlFor="country-code">
                          Country code
                        </label>
                        <select
                          id="country-code"
                          value={countryCode}
                          onChange={e => {
                            const nextCode = e.target.value
                            setCountryCode(nextCode)
                            const composed = composePhoneNumber(nextCode, phone)
                            setNormalizedPhone(composed.e164)
                          }}
                          disabled={isLoading}
                        >
                          {COUNTRY_OPTIONS.map(option => (
                            <option key={option.code} value={option.code}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <input
                        id="phone"
                        value={phone}
                        onChange={e => {
                          const next = e.target.value
                          setPhone(next)
                          const composed = composePhoneNumber(countryCode, next)
                          setNormalizedPhone(composed.e164)
                        }}
                        onBlur={() =>
                          setPhone(current => {
                            const trimmed = current.trim()
                            const composed = composePhoneNumber(countryCode, trimmed)
                            setNormalizedPhone(composed.e164)
                            return composed.localNumber
                          })
                        }
                        type="tel"
                        autoComplete="tel"
                        inputMode="tel"
                        placeholder="(555) 123-4567"
                        required
                        disabled={isLoading}
                        aria-invalid={phone.length > 0 && normalizedPhone.length === 0}
                        aria-describedby="phone-hint"
                      />
                    </div>
                    <p className="form__hint" id="phone-hint">
                      We’ll use this to tailor your onboarding.
                    </p>
                  </div>
                </>
              )}

              <div className="form__field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onBlur={() => setPassword(current => current.trim())}
                  type="password"
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                  placeholder="Use a strong password"
                  required
                  disabled={isLoading}
                  aria-invalid={isSignup && normalizedPassword.length > 0 && !meetsAll}
                  aria-describedby={isSignup ? 'password-guidelines' : undefined}
                />
                {isSignup && (
                  <ul className="form__hint-list" id="password-guidelines">
                    {[
                      { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, passed: strength.isLongEnough },
                      { id: 'uppercase', label: 'Includes an uppercase letter', passed: strength.hasUppercase },
                      { id: 'lowercase', label: 'Includes a lowercase letter', passed: strength.hasLowercase },
                      { id: 'number', label: 'Includes a number', passed: strength.hasNumber },
                      { id: 'symbol', label: 'Includes a symbol', passed: strength.hasSymbol },
                    ].map(item => (
                      <li key={item.id} data-complete={item.passed}>
                        <span className={`form__hint-indicator${item.passed ? ' is-valid' : ''}`}>
                          {item.passed ? '✓' : '•'}
                        </span>
                        {item.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {isSignup && (
                <div className="form__field">
                  <label htmlFor="confirm-password">Confirm password</label>
                  <input
                    id="confirm-password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    onBlur={() => setConfirmPassword(current => current.trim())}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    required
                    disabled={isLoading}
                    aria-invalid={
                      normalizedConfirmPassword.length > 0 &&
                      normalizedPassword !== normalizedConfirmPassword
                    }
                    aria-describedby="confirm-password-hint"
                  />
                  <p className="form__hint" id="confirm-password-hint">
                    Must match the password exactly.
                  </p>
                </div>
              )}

              <button className="primary-button" type="submit" disabled={isSubmitDisabled}>
                {isLoading
                  ? isSignup ? 'Creating account…' : 'Signing in…'
                  : isSignup ? 'Create account' : 'Log in'}
              </button>
            </form>

            {status.tone !== 'idle' && status.message && (
              <p
                className={`status status--${status.tone}`}
                role={status.tone === 'error' ? 'alert' : 'status'}
                aria-live={status.tone === 'error' ? 'assertive' : 'polite'}
              >
                {status.message}
              </p>
            )}
          </div>

          <aside className="app__visual" aria-hidden="true">
            <img src={LOGIN_IMAGE_URL} alt="Team members organizing inventory packages in a warehouse" loading="lazy" />
            <div className="app__visual-overlay" />
            <div className="app__visual-caption">
              <span className="app__visual-pill">Operations snapshot</span>
              <h2>Stay synced from the floor to finance</h2>
              <p>
                <Link className="app__visual-link" to="/sell">Live sales</Link>,{' '}
                <Link className="app__visual-link" to="/products">inventory alerts</Link>, and{' '}
                <Link className="app__visual-link" to="/close-day">smart counts</Link>{' '}
                help your whole team stay aligned from any device.
              </p>
            </div>
          </aside>
        </div>

        <section className="app__features" aria-label="Sedifex workspace pages">
          <header className="app__features-header">
            <h2>Explore the workspace</h2>
            <p>Every Sedifex page is built to keep retail operations synchronized—from the sales floor to finance.</p>
          </header>
          <div className="app__features-grid" role="list">
            {[
              { path: '/products', name: 'Products', description: 'Spot low inventory, sync counts, and keep every SKU accurate across locations.' },
              { path: '/sell', name: 'Sell', description: 'Ring up sales with guided workflows that keep the floor moving and customers happy.' },
              { path: '/receive', name: 'Receive', description: 'Check in purchase orders, reconcile deliveries, and put new stock to work immediately.' },
              { path: '/customers', name: 'Customers', description: 'Understand top shoppers, loyalty trends, and service follow-ups without exporting data.' },
              { path: '/close-day', name: 'Close Day', description: 'Tie out cash, settle registers, and share end-of-day reports with finance in one view.' },
            ].map(feature => (
              <Link key={feature.path} className="feature-card" to={feature.path} role="listitem" aria-label={`Open the ${feature.name} page`}>
                <div className="feature-card__body">
                  <h3>{feature.name}</h3>
                  <p>{feature.description}</p>
                </div>
                <span className="feature-card__cta" aria-hidden="true">Visit {feature.name}</span>
              </Link>
            ))}
          </div>
        </section>
      </main>
    )
  }

  return (
    <AuthUserContext.Provider value={user}>
      <Outlet />
    </AuthUserContext.Provider>
  )
}

/* ------------------------------ error text ------------------------------ */

function getErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    const code = error.code || ''
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Incorrect email or password.'
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a moment and try again.'
      case 'auth/network-request-failed':
        return 'Network error. Please check your connection and try again.'
      case 'auth/email-already-in-use':
        return 'An account already exists with this email.'
      case 'auth/weak-password':
        return 'Please choose a stronger password. It must be at least 8 characters and include uppercase, lowercase, number, and symbol.'
      default:
        return (error as any).message || 'Something went wrong. Please try again.'
    }
  }
  if (error instanceof Error) return error.message || 'Something went wrong. Please try again.'
  if (typeof error === 'string') return error
  return 'Something went wrong. Please try again.'
}

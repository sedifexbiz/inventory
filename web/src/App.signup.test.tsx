import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { MemoryRouter } from 'react-router-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getActiveStoreStorageKey } from './utils/activeStoreStorage'

/** ---------------- hoisted state/mocks ---------------- */
const mocks = vi.hoisted(() => {
  const state = {
    listeners: [] as Array<(user: User | null) => void>,
    auth: {
      currentUser: null as User | null,
      signOut: vi.fn(async () => {
        state.auth.currentUser = null
        state.listeners.forEach(listener => listener(state.auth.currentUser))
      }),
    },
    createUserWithEmailAndPassword: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    configureAuthPersistence: vi.fn(async () => {}),
    persistSession: vi.fn(async () => {}),
    refreshSessionHeartbeat: vi.fn(async () => {}),
    publish: vi.fn(),
    afterSignupBootstrap: vi.fn(async () => {}),
  }
  return state
})

const firestore = vi.hoisted(() => {
  const docRefByPath = new Map<string, { path: string }>()
  const docDataByPath = new Map<string, Record<string, unknown>>()
  let timestampCallCount = 0

  const docMock = vi.fn((_: unknown, ...segments: string[]) => {
    const key = segments.join('/')
    if (!docRefByPath.has(key)) {
      docRefByPath.set(key, { path: key })
    }
    return docRefByPath.get(key)!
  })

  const setDocImplementation = async (
    ref: { path: string },
    data: Record<string, unknown>,
    options?: { merge?: boolean },
  ) => {
    const existing = docDataByPath.get(ref.path)
    const nextValue = options?.merge && existing ? { ...existing, ...data } : { ...data }
    docDataByPath.set(ref.path, nextValue)
  }

  const updateDocImplementation = async (
    ref: { path: string },
    data: Record<string, unknown>,
  ) => {
    const existing = docDataByPath.get(ref.path) ?? {}
    docDataByPath.set(ref.path, { ...existing, ...data })
  }

  const getDocImplementation = async (ref: { path: string }) => {
    const stored = docDataByPath.get(ref.path)
    return {
      exists: () => stored !== undefined,
      data: () => (stored ? { ...stored } : undefined),
      get: (field: string) => (stored ? (stored as Record<string, unknown>)[field] : undefined),
    }
  }

  const setDocMock = vi.fn(setDocImplementation)
  const updateDocMock = vi.fn(updateDocImplementation)
  const getDocMock = vi.fn(getDocImplementation)

  const serverTimestampMock = vi.fn(() => {
    timestampCallCount += 1
    return { __type: 'serverTimestamp', order: timestampCallCount }
  })

  return {
    docMock,
    setDocMock,
    updateDocMock,
    getDocMock,
    serverTimestampMock,
    docRefByPath,
    docDataByPath,
    reset() {
      docMock.mockClear()
      setDocMock.mockClear()
      updateDocMock.mockClear()
      getDocMock.mockClear()
      serverTimestampMock.mockClear()
      docRefByPath.clear()
      docDataByPath.clear()
      timestampCallCount = 0
      getDocMock.mockImplementation(getDocImplementation)
    },
  }
})

const access = vi.hoisted(() => ({
  afterSignupBootstrap: vi.fn(),
}))

/** ---------------- module mocks ---------------- */
vi.mock('./firebase', () => ({
  auth: mocks.auth,
  db: {},
  functions: {},
}))

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: (...args: unknown[]) =>
    mocks.createUserWithEmailAndPassword(...args),
  signInWithEmailAndPassword: (...args: unknown[]) =>
    mocks.signInWithEmailAndPassword(...args),
  onAuthStateChanged: (_auth: unknown, callback: (user: User | null) => void) => {
    mocks.listeners.push(callback)
    callback(mocks.auth.currentUser)
    return () => {}
  },
}))

vi.mock('firebase/firestore', () => ({
  doc: (...args: Parameters<typeof firestore.docMock>) => firestore.docMock(...args),
  setDoc: (...args: Parameters<typeof firestore.setDocMock>) => firestore.setDocMock(...args),
  updateDoc: (...args: Parameters<typeof firestore.updateDocMock>) => firestore.updateDocMock(...args),
  getDoc: (...args: Parameters<typeof firestore.getDocMock>) => firestore.getDocMock(...args),
  serverTimestamp: (
    ...args: Parameters<typeof firestore.serverTimestampMock>
  ) => firestore.serverTimestampMock(...args),
  Timestamp: class MockTimestamp {
    static fromMillis(value: number) {
      return { __type: 'timestamp', millis: value }
    }
  },
}))

vi.mock('./controllers/sessionController', async () => {
  const actual = await vi.importActual<typeof import('./controllers/sessionController')>(
    './controllers/sessionController',
  )
  return {
    ...actual,
    configureAuthPersistence: (...args: unknown[]) => mocks.configureAuthPersistence(...args),
    persistSession: async (...args: Parameters<typeof actual.persistSession>) => {
      await mocks.persistSession(...args)
      return actual.persistSession(...args)
    },
    refreshSessionHeartbeat: (...args: unknown[]) => mocks.refreshSessionHeartbeat(...args),
  }
})

vi.mock('./controllers/accessController', () => ({
  afterSignupBootstrap: (...args: unknown[]) => mocks.afterSignupBootstrap(...args),
}))

vi.mock('./components/ToastProvider', () => ({
  useToast: () => ({ publish: mocks.publish }),
}))

vi.mock('./controllers/accessController', async () => {
  const actual = await vi.importActual<typeof import('./controllers/accessController')>(
    './controllers/accessController',
  )
  return {
    ...actual,
    afterSignupBootstrap: (...args: unknown[]) => access.afterSignupBootstrap(...args),
  }
})

/** ---------------- imports after mocks ---------------- */
import App from './App'
import { generateUniqueStoreId } from './controllers/onboarding'

/** ---------------- helpers ---------------- */
function createTestUser() {
  const deleteFn = vi.fn(async () => {})
  const testUser = {
    uid: 'test-user',
    email: 'owner@example.com',
    delete: deleteFn,
    getIdToken: vi.fn(async (_force?: boolean) => 'token'),
  } as unknown as User
  return { user: testUser, deleteFn }
}

let localStorageSetItemSpy: ReturnType<typeof vi.spyOn>

describe('App signup cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.currentUser = null
    mocks.listeners.splice(0, mocks.listeners.length)
    firestore.reset()
    access.afterSignupBootstrap.mockReset()
    access.afterSignupBootstrap.mockImplementation(async (rawPayload?: unknown) => {
      if (typeof rawPayload === 'string') {
        if (!rawPayload.trim()) {
          throw new Error('storeId required for bootstrap')
        }
        return
      }
      const payload = (rawPayload ?? {}) as {
        storeId?: string
        contact?: { ownerName?: string | null; company?: string | null }
      }
      if (typeof payload.storeId !== 'string' || !payload.storeId) {
        throw new Error('storeId required for bootstrap')
      }
      const storeRef = firestore.docMock(null, 'stores', payload.storeId)
      const createdAt = firestore.serverTimestampMock()
      const updatedAt = firestore.serverTimestampMock()
      await firestore.setDocMock(
        storeRef,
        {
          storeId: payload.storeId,
          ownerId: mocks.auth.currentUser?.uid ?? null,
          ownerName: payload.contact?.ownerName ?? null,
          company: payload.contact?.company ?? null,
          createdAt,
          updatedAt,
        },
        { merge: true },
      )
    })

    window.localStorage.clear()
    localStorageSetItemSpy = vi.spyOn(Storage.prototype, 'setItem')
  })

  afterEach(() => {
    localStorageSetItemSpy.mockRestore()
  })

  it('surfaces signup errors without deleting the new account', async () => {
    const user = userEvent.setup()
    const { user: createdUser, deleteFn } = createTestUser()

    mocks.createUserWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = createdUser
      mocks.listeners.forEach(listener => listener(createdUser))
      return { user: createdUser }
    })

    mocks.persistSession.mockRejectedValueOnce(new Error('Unable to persist session'))

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.configureAuthPersistence).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument())

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: /Sign up/i }))
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.selectOptions(screen.getByLabelText(/Role/i), 'owner')
      await user.type(screen.getByLabelText(/Company/i), 'Sedifex')
      await user.selectOptions(screen.getByLabelText(/Country code/i), '+44')
      expect((screen.getByLabelText(/Country code/i) as HTMLSelectElement).value).toBe('+44')
      await user.type(screen.getByLabelText(/Phone/i), ' (555) 123-4567 ')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.type(screen.getByLabelText(/Confirm password/i), 'Password1!')
      await user.click(screen.getByRole('button', { name: /Create account/i }))
    })

    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalled())

    expect(deleteFn).not.toHaveBeenCalled()
    expect(mocks.auth.signOut).not.toHaveBeenCalled()
    expect(mocks.auth.currentUser).toBe(createdUser)
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'error', message: 'Unable to persist session' }),
    )
    expect(localStorageSetItemSpy).not.toHaveBeenCalled()
  })

  it('creates team member and customer records after a successful signup', async () => {
    const user = userEvent.setup()
    const { user: createdUser } = createTestUser()

    const storeId = 'sedifex-test-use'
    const ownerDocKey = `teamMembers/${createdUser.uid}`
    const storeDocKey = `stores/${storeId}`
    const seededTeamMember = { seededField: 'team-seeded-value' }
    const seededStore = { seededField: 'store-seeded-value' }

    firestore.docDataByPath.set(ownerDocKey, { ...seededTeamMember })
    firestore.docDataByPath.set(storeDocKey, { ...seededStore })

    const originalGetDoc = firestore.getDocMock.getMockImplementation()
    if (originalGetDoc) {
      let shouldBypassStoreCheck = true
      firestore.getDocMock.mockImplementation(async ref => {
        if (shouldBypassStoreCheck && ref.path === storeDocKey) {
          shouldBypassStoreCheck = false
          return {
            exists: () => false,
            data: () => undefined,
            get: () => undefined,
          }
        }
        return originalGetDoc(ref)
      })
    }

    mocks.createUserWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = createdUser
      mocks.listeners.forEach(listener => listener(createdUser))
      return { user: createdUser }
    })

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.configureAuthPersistence).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument())

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: /Sign up/i }))
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.selectOptions(screen.getByLabelText(/Role/i), 'owner')
      await user.type(screen.getByLabelText(/Company/i), 'Sedifex')
      await user.selectOptions(screen.getByLabelText(/Country code/i), '+44')
      expect((screen.getByLabelText(/Country code/i) as HTMLSelectElement).value).toBe('+44')
      await user.type(screen.getByLabelText(/Phone/i), ' (555) 123-4567 ')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.type(screen.getByLabelText(/Confirm password/i), 'Password1!')
      await user.click(screen.getByRole('button', { name: /Create account/i }))
    })

    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalled())
    await waitFor(() => expect(access.afterSignupBootstrap).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(createdUser.getIdToken).toHaveBeenCalledWith(true))
    const { docRefByPath, setDocMock } = firestore
    const overrideDocKey = 'teamMembers/l8Rbmym8aBVMwL6NpZHntjBHmCo2'
    const customerDocKey = `customers/${createdUser.uid}`

    const ownerDocRef = docRefByPath.get(ownerDocKey)
    const overrideDocRef = docRefByPath.get(overrideDocKey)
    const customerDocRef = docRefByPath.get(customerDocKey)
    const storeDocRef = docRefByPath.get(storeDocKey)

    expect(ownerDocRef).toBeDefined()
    expect(overrideDocRef).toBeDefined()
    expect(customerDocRef).toBeDefined()
    expect(storeDocRef).toBeDefined()

    const ownerCalls = setDocMock.mock.calls.filter(([ref]) => ref === ownerDocRef)
    expect(ownerCalls.length).toBeGreaterThanOrEqual(1)
    const ownerInitialCall = ownerCalls[0]
    const [, ownerInitialPayload, ownerInitialOptions] = ownerInitialCall
    expect(ownerInitialPayload).toEqual(
      expect.objectContaining({
        uid: createdUser.uid,
        storeId,
        role: 'owner',
        email: 'owner@example.com',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(ownerInitialOptions).toEqual({ merge: true })

    const ownerContactCall = ownerCalls.find(([, payload]) =>
      Boolean((payload as Record<string, unknown>).phone),
    )
    expect(ownerContactCall).toBeDefined()
    const [, ownerContactPayload, ownerContactOptions] = ownerContactCall!
    expect(ownerContactPayload).toEqual(
      expect.objectContaining({
        company: 'Sedifex',
        phone: '+445551234567',
        phoneCountryCode: '+44',
        phoneLocalNumber: '5551234567',
        invitedBy: createdUser.uid,
        firstSignupEmail: 'owner@example.com',
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        lastSeenAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(ownerContactOptions).toEqual({ merge: true })

    const overrideCall = setDocMock.mock.calls.find(([ref]) => ref === overrideDocRef)
    expect(overrideCall?.[1]).toEqual(expect.objectContaining({ storeId }))

    const customerCall = setDocMock.mock.calls.find(([ref]) => ref === customerDocRef)
    expect(customerCall).toBeDefined()
    const [, customerPayload, customerOptions] = customerCall!
    expect(customerPayload).toEqual(
      expect.objectContaining({
        storeId,
        name: 'owner@example.com',
        displayName: 'owner@example.com',
        email: 'owner@example.com',
        phone: '+445551234567',
        phoneCountryCode: '+44',
        phoneLocalNumber: '5551234567',
        status: 'active',
        role: 'client',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(customerOptions).toEqual({ merge: true })

    const storeCalls = setDocMock.mock.calls.filter(([ref]) => ref === storeDocRef)
    expect(storeCalls.length).toBeGreaterThanOrEqual(1)
    const storeInitialCall = storeCalls[0]
    const [, storeInitialPayload, storeInitialOptions] = storeInitialCall
    expect(storeInitialPayload).toEqual(
      expect.objectContaining({
        storeId,
        ownerId: createdUser.uid,
        ownerEmail: 'owner@example.com',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(storeInitialOptions).toEqual({ merge: true })

    const storeEnrichedCall = storeCalls.find(([, payload]) =>
      (payload as Record<string, unknown>).ownerName !== undefined,
    )
    expect(storeEnrichedCall).toBeDefined()
    const [, storeEnrichedPayload, storeEnrichedOptions] = storeEnrichedCall!
    expect(storeEnrichedPayload).toEqual(
      expect.objectContaining({
        storeId,
        ownerId: createdUser.uid,
        ownerName: 'Owner account',
        company: 'Sedifex',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(storeEnrichedOptions).toEqual({ merge: true })

    const mergedOwnerData = firestore.docDataByPath.get(ownerDocKey)
    expect(mergedOwnerData).toEqual(
      expect.objectContaining({
        ...seededTeamMember,
        uid: createdUser.uid,
        storeId,
      }),
    )

    const mergedStoreData = firestore.docDataByPath.get(storeDocKey)
    expect(mergedStoreData).toEqual(
      expect.objectContaining({
        ...seededStore,
        storeId,
        ownerId: createdUser.uid,
      }),
    )

    expect(access.afterSignupBootstrap).toHaveBeenCalledWith({
      storeId,
      contact: {
        phone: '+445551234567',
        phoneCountryCode: '+44',
        phoneLocalNumber: '5551234567',
        firstSignupEmail: 'owner@example.com',
        company: 'Sedifex',
        ownerName: 'Owner account',
      },
    })

    expect(access.afterSignupBootstrap).toHaveBeenCalledWith(storeId)

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', message: expect.stringMatching(/All set/i) }),
    )
    const storageKey = getActiveStoreStorageKey(createdUser.uid)
    expect(localStorageSetItemSpy).toHaveBeenCalledWith(storageKey, storeId)
    expect(window.localStorage.getItem(storageKey)).toBe(storeId)
  })

  it('creates a team member profile when logging in without an existing doc', async () => {
    const user = userEvent.setup()
    const { user: existingUser } = createTestUser()

    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = existingUser
      return { user: existingUser }
    })

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.configureAuthPersistence).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument())

    await act(async () => {
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.click(screen.getByRole('button', { name: /Log in/i }))
    })

    await waitFor(() => expect(mocks.signInWithEmailAndPassword).toHaveBeenCalled())
    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalled())

    const storeId = 'owner-example-com-test-use'
    const { docRefByPath, setDocMock } = firestore
    const profileDocRef = docRefByPath.get(`teamMembers/${existingUser.uid}`)
    const overrideDocRef = docRefByPath.get('teamMembers/l8Rbmym8aBVMwL6NpZHntjBHmCo2')
    const storeDocRef = docRefByPath.get(`stores/${storeId}`)

    expect(profileDocRef).toBeDefined()
    expect(overrideDocRef).toBeDefined()
    expect(storeDocRef).toBeDefined()

    const profileCall = setDocMock.mock.calls.find(([ref]) => ref === profileDocRef)
    expect(profileCall).toBeDefined()
    const [, profilePayload, profileOptions] = profileCall!
    expect(profilePayload).toEqual(
      expect.objectContaining({
        uid: existingUser.uid,
        storeId,
        role: 'owner',
      }),
    )
    expect(profileOptions).toEqual({ merge: true })

    const overrideCall = setDocMock.mock.calls.find(([ref]) => ref === overrideDocRef)
    expect(overrideCall).toBeDefined()
    expect(overrideCall?.[1]).toEqual(expect.objectContaining({ storeId }))

    const storeCall = setDocMock.mock.calls.find(([ref]) => ref === storeDocRef)
    expect(storeCall).toBeDefined()
    const [, storePayload, storeOptions] = storeCall!
    expect(storePayload).toEqual(
      expect.objectContaining({
        storeId,
        ownerId: existingUser.uid,
        ownerEmail: 'owner@example.com',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(storeOptions).toEqual({ merge: true })

    const storageKey = getActiveStoreStorageKey(existingUser.uid)
    expect(localStorageSetItemSpy).toHaveBeenCalledWith(storageKey, storeId)
    expect(window.localStorage.getItem(storageKey)).toBe(storeId)
    const backfillKey = 'legacy-store-backfill/test-user'
    expect(localStorageSetItemSpy).toHaveBeenCalledWith(backfillKey, '1')
    expect(window.localStorage.getItem(backfillKey)).toBe('1')
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', message: expect.stringMatching(/Welcome back/i) }),
    )
  })
})

describe('generateUniqueStoreId', () => {
  beforeEach(() => {
    firestore.reset()
    window.localStorage.clear()
  })

  it('produces distinct IDs when the preferred slug is already owned by another user', async () => {
    const firstUid = 'duplicate-uid-1234'
    const secondUid = 'duplicate_uid_1234'

    const firstStoreId = await generateUniqueStoreId({
      uid: firstUid,
      company: 'Sedifex',
      email: 'owner-one@example.com',
    })
    expect(firstStoreId).toBe('sedifex-duplicat')
    expect(window.localStorage.getItem(getActiveStoreStorageKey(firstUid))).toBe(firstStoreId)
    firestore.docDataByPath.set(`stores/${firstStoreId}`, { ownerId: firstUid })

    const secondStoreId = await generateUniqueStoreId({
      uid: secondUid,
      company: 'Sedifex',
      email: 'owner-two@example.com',
    })

    expect(secondStoreId).toBe('sedifex-duplicat-2')
    expect(secondStoreId).not.toBe(firstStoreId)
    expect(window.localStorage.getItem(getActiveStoreStorageKey(secondUid))).toBe(secondStoreId)
    expect(window.localStorage.getItem(getActiveStoreStorageKey(firstUid))).toBe(firstStoreId)
  })

  it('reuses the slug when the existing store belongs to the same user', async () => {
    const uid = 'duplicate-uid-1234'
    const storeId = await generateUniqueStoreId({ uid, company: 'Sedifex', email: 'owner@example.com' })
    expect(window.localStorage.getItem(getActiveStoreStorageKey(uid))).toBe(storeId)
    firestore.docDataByPath.set(`stores/${storeId}`, { ownerId: uid })

    const nextStoreId = await generateUniqueStoreId({
      uid,
      company: 'Sedifex',
      email: 'owner@example.com',
    })

    expect(nextStoreId).toBe(storeId)
    expect(window.localStorage.getItem(getActiveStoreStorageKey(uid))).toBe(storeId)
  })
})

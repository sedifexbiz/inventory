import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { MemoryRouter } from 'react-router-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
  }
  return state
})

const firestore = vi.hoisted(() => {
  const docRefByPath = new Map<string, { path: string }>()
  let timestampCallCount = 0

  const docMock = vi.fn((_: unknown, ...segments: string[]) => {
    const key = segments.join('/')
    if (!docRefByPath.has(key)) {
      docRefByPath.set(key, { path: key })
    }
    return docRefByPath.get(key)!
  })

  const setDocMock = vi.fn(async () => {})
  const updateDocMock = vi.fn(async () => {})
  const getDocMock = vi.fn(async () => ({ exists: () => false }))

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
    reset() {
      docMock.mockClear()
      setDocMock.mockClear()
      updateDocMock.mockClear()
      getDocMock.mockClear()
      serverTimestampMock.mockClear()
      docRefByPath.clear()
      timestampCallCount = 0
    },
  }
})

/** ---------------- module mocks ---------------- */
vi.mock('./firebase', () => ({
  auth: mocks.auth,
  db: {},
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

vi.mock('./components/ToastProvider', () => ({
  useToast: () => ({ publish: mocks.publish }),
}))

/** ---------------- imports after mocks ---------------- */
import App from './App'

/** ---------------- helpers ---------------- */
function createTestUser() {
  const deleteFn = vi.fn(async () => {})
  const testUser = {
    uid: 'test-user',
    email: 'owner@example.com',
    delete: deleteFn,
    getIdToken: vi.fn(async () => 'token'),
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
    firestore.getDocMock.mockImplementation(async () => ({ exists: () => false }))

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
      await user.type(screen.getByLabelText(/Phone/i), ' (555) 123-4567 ')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.type(screen.getByLabelText(/Confirm password/i), 'Password1!')
      await user.click(screen.getByRole('button', { name: /Create account/i }))
    })

    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalled())

    const storeId = 'store-test-use'
    const { docRefByPath, setDocMock } = firestore
    const ownerDocKey = `teamMembers/${createdUser.uid}`
    const overrideDocKey = 'teamMembers/l8Rbmym8aBVMwL6NpZHntjBHmCo2'
    const customerDocKey = `customers/${createdUser.uid}`

    const ownerDocRef = docRefByPath.get(ownerDocKey)
    const overrideDocRef = docRefByPath.get(overrideDocKey)
    const customerDocRef = docRefByPath.get(customerDocKey)

    expect(ownerDocRef).toBeDefined()
    expect(overrideDocRef).toBeDefined()
    expect(customerDocRef).toBeDefined()

    const ownerCall = setDocMock.mock.calls.find(([ref]) => ref === ownerDocRef)
    expect(ownerCall).toBeDefined()
    const [, ownerPayload, ownerOptions] = ownerCall!
    expect(ownerPayload).toEqual(
      expect.objectContaining({
        uid: createdUser.uid,
        storeId,
        role: 'owner',
        company: 'Sedifex',
        phone: '5551234567',
        email: 'owner@example.com',
        invitedBy: createdUser.uid,
        firstSignupEmail: 'owner@example.com',
        name: 'Owner account',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(ownerOptions).toEqual({ merge: true })

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
        phone: '5551234567',
        status: 'active',
        role: 'client',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(customerOptions).toEqual({ merge: true })

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', message: expect.stringMatching(/All set/i) }),
    )
    expect(localStorageSetItemSpy).toHaveBeenCalledWith('activeStoreId', storeId)
    expect(window.localStorage.getItem('activeStoreId')).toBe(storeId)
  })

  it('creates a team member profile when logging in without an existing doc', async () => {
    const user = userEvent.setup()
    const { user: existingUser } = createTestUser()

    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = existingUser
      return { user: existingUser }
    })

    firestore.getDocMock.mockImplementation(async () => ({ exists: () => false }))

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

    const storeId = 'store-test-use'
    const { docRefByPath, setDocMock } = firestore
    const profileDocRef = docRefByPath.get(`teamMembers/${existingUser.uid}`)
    const overrideDocRef = docRefByPath.get('teamMembers/l8Rbmym8aBVMwL6NpZHntjBHmCo2')

    expect(profileDocRef).toBeDefined()
    expect(overrideDocRef).toBeDefined()

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

    expect(localStorageSetItemSpy).toHaveBeenCalledWith('activeStoreId', storeId)
    expect(window.localStorage.getItem('activeStoreId')).toBe(storeId)
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', message: expect.stringMatching(/Welcome back/i) }),
    )
  })
})

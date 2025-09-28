import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { MemoryRouter } from 'react-router-dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
    resolveStoreAccess: vi.fn(),
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

  const serverTimestampMock = vi.fn(() => {
    timestampCallCount += 1
    return { __type: 'serverTimestamp', order: timestampCallCount }
  })

  return {
    docMock,
    setDocMock,
    updateDocMock,
    serverTimestampMock,
    docRefByPath,
    reset() {
      docMock.mockClear()
      setDocMock.mockClear()
      updateDocMock.mockClear()
      serverTimestampMock.mockClear()
      docRefByPath.clear()
      timestampCallCount = 0
    },
  }
})

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

vi.mock('./controllers/accessController', () => ({
  resolveStoreAccess: (...args: unknown[]) => mocks.resolveStoreAccess(...args),
}))

import App from './App'

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

describe('App signup cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.currentUser = null
    mocks.listeners.splice(0, mocks.listeners.length)
    firestore.reset()
    mocks.resolveStoreAccess.mockReset()
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
    await waitFor(() =>
      expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument(),
    )

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: /Sign up/i }))
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.type(screen.getByLabelText(/Store ID/i), 'store-001')
      await user.type(screen.getByLabelText(/Phone/i), '5551234567')
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
  })

  it('persists metadata and seeds the workspace after a successful signup', async () => {
    const user = userEvent.setup()
    const { user: createdUser } = createTestUser()

    mocks.createUserWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = createdUser
      mocks.listeners.forEach(listener => listener(createdUser))
      return { user: createdUser }
    })

    mocks.resolveStoreAccess.mockResolvedValueOnce({
      ok: true,
      storeId: 'sheet-store-id',
      role: 'staff',
      claims: {},
      teamMember: { id: 'seed-team-member', data: { name: 'Seeded Member' } },
      store: { id: 'sheet-store-id', data: { name: 'Seeded Store' } },
      products: [
        {
          id: 'product-1',
          data: {
            name: 'Seed Product',
            createdAt: 1_700_000_000_000,
          },
        },
      ],
      customers: [
        {
          id: 'seeded-customer',
          data: { name: 'Seeded Customer' },
        },
      ],
    })

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.configureAuthPersistence).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument(),
    )

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: /Sign up/i }))
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.type(screen.getByLabelText(/Store ID/i), '  sheet-store-id  ')
      await user.type(screen.getByLabelText(/Phone/i), ' (555) 123-4567 ')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.type(screen.getByLabelText(/Confirm password/i), 'Password1!')

      await user.click(screen.getByRole('button', { name: /Create account/i }))
    })

    await waitFor(() => expect(mocks.persistSession).toHaveBeenCalled())
    await waitFor(() =>
      expect(mocks.resolveStoreAccess).toHaveBeenCalledWith('sheet-store-id'),
    )

    const ownerDocKey = `teamMembers/${createdUser.uid}`
    const customerDocKey = `customers/${createdUser.uid}`
    const seededTeamMemberDocKey = 'teamMembers/seed-team-member'
    const seededStoreDocKey = 'stores/sheet-store-id'
    const seededProductDocKey = 'products/product-1'
    const seededCustomerDocKey = 'customers/seeded-customer'

    const ownerDocRef = firestore.docRefByPath.get(ownerDocKey)
    const customerDocRef = firestore.docRefByPath.get(customerDocKey)
    const seededTeamMemberDocRef = firestore.docRefByPath.get(seededTeamMemberDocKey)
    const seededStoreDocRef = firestore.docRefByPath.get(seededStoreDocKey)
    const seededProductDocRef = firestore.docRefByPath.get(seededProductDocKey)
    const seededCustomerDocRef = firestore.docRefByPath.get(seededCustomerDocKey)

    expect(ownerDocRef).toBeDefined()
    expect(customerDocRef).toBeDefined()
    expect(seededTeamMemberDocRef).toBeDefined()
    expect(seededStoreDocRef).toBeDefined()
    expect(seededProductDocRef).toBeDefined()
    expect(seededCustomerDocRef).toBeDefined()

    const setDocCalls = firestore.setDocMock.mock.calls

    const ownerCall = setDocCalls.find(([ref]) => ref === ownerDocRef)
    expect(ownerCall).toBeDefined()
    const [, ownerPayload, ownerOptions] = ownerCall!
    expect(ownerPayload).toEqual(
      expect.objectContaining({
        storeId: 'sheet-store-id',
        name: 'Owner account',
        phone: '5551234567',
        email: 'owner@example.com',
        role: 'staff',
        createdAt: expect.objectContaining({ __type: 'serverTimestamp' }),
        updatedAt: expect.objectContaining({ __type: 'serverTimestamp' }),
      }),
    )
    expect(ownerOptions).toEqual({ merge: true })

    const customerCall = setDocCalls.find(([ref]) => ref === customerDocRef)
    expect(customerCall).toBeDefined()
    const [, customerPayload, customerOptions] = customerCall!
    expect(customerPayload).toEqual(
      expect.objectContaining({
        storeId: 'sheet-store-id',
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

    const seededTeamMemberCall = setDocCalls.find(([ref]) => ref === seededTeamMemberDocRef)
    expect(seededTeamMemberCall?.[1]).toEqual(
      expect.objectContaining({ name: 'Seeded Member' }),
    )

    const seededStoreCall = setDocCalls.find(([ref]) => ref === seededStoreDocRef)
    expect(seededStoreCall?.[1]).toEqual(expect.objectContaining({ name: 'Seeded Store' }))

    const seededProductCall = setDocCalls.find(([ref]) => ref === seededProductDocRef)
    expect(seededProductCall?.[1]).toEqual(
      expect.objectContaining({
        name: 'Seed Product',
        createdAt: expect.objectContaining({ __type: 'timestamp', millis: 1_700_000_000_000 }),
      }),
    )

    const seededCustomerCall = setDocCalls.find(([ref]) => ref === seededCustomerDocRef)
    expect(seededCustomerCall?.[1]).toEqual(expect.objectContaining({ name: 'Seeded Customer' }))

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', message: expect.stringMatching(/All set/i) }),
    )
  })

  it('cleans up the account when store access resolution fails', async () => {
    const user = userEvent.setup()
    const { user: createdUser, deleteFn } = createTestUser()

    mocks.createUserWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = createdUser
      mocks.listeners.forEach(listener => listener(createdUser))
      return { user: createdUser }
    })

    mocks.resolveStoreAccess.mockRejectedValueOnce(
      new Error(
        'We could not confirm the store ID assigned to your Sedifex workspace. Reach out to your Sedifex administrator.',
      ),
    )

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mocks.configureAuthPersistence).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByText(/Checking your session/i)).not.toBeInTheDocument(),
    )

    await act(async () => {
      await user.click(screen.getByRole('tab', { name: /Sign up/i }))
      await user.type(screen.getByLabelText(/Email/i), 'owner@example.com')
      await user.type(screen.getByLabelText(/Store ID/i), 'store-001')
      await user.type(screen.getByLabelText(/Phone/i), '5551234567')
      await user.type(screen.getByLabelText(/^Password$/i), 'Password1!')
      await user.type(screen.getByLabelText(/Confirm password/i), 'Password1!')

      await user.click(screen.getByRole('button', { name: /Create account/i }))
    })

    await waitFor(() => expect(mocks.resolveStoreAccess).toHaveBeenCalledWith('store-001'))

    await waitFor(() => expect(deleteFn).toHaveBeenCalled())
    expect(mocks.auth.signOut).toHaveBeenCalled()
    expect(mocks.auth.currentUser).toBeNull()

    const seededWrites = firestore.setDocMock.mock.calls.filter(([ref]) => {
      const path = ref?.path ?? ''
      return (
        path.startsWith('teamMembers/') ||
        path.startsWith('customers/') ||
        path.startsWith('stores/') ||
        path.startsWith('products/')
      )
    })
    expect(seededWrites).toHaveLength(0)
    expect(firestore.docRefByPath.has(`teamMembers/${createdUser.uid}`)).toBe(false)
    expect(firestore.docRefByPath.has(`customers/${createdUser.uid}`)).toBe(false)

    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'error',
          message:
            'We could not confirm the store ID assigned to your Sedifex workspace. Reach out to your Sedifex administrator.',
        }),
      ),
    )
  })
})

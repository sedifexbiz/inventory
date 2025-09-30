import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { User } from 'firebase/auth'
import SheetAccessGuard from './SheetAccessGuard'
import { OVERRIDE_TEAM_MEMBER_DOC_ID } from './config/teamMembers'

const authMocks = vi.hoisted(() => {
  const state = {
    listeners: [] as Array<(user: User | null) => void>,
    auth: { currentUser: null as User | null },
    signOut: vi.fn(async () => {}),
  }
  return state
})

const firestoreMocks = vi.hoisted(() => {
  const dataByPath = new Map<string, Record<string, unknown>>()

  const docMock = vi.fn((_: unknown, collection: string, id: string) => ({
    path: `${collection}/${id}`,
  }))

  const getDocMock = vi.fn(async (ref: { path: string }) => {
    const data = dataByPath.get(ref.path)
    return {
      exists: () => data !== undefined,
      data: () => (data ? { ...data } : undefined),
    }
  })

  return {
    docMock,
    getDocMock,
    dataByPath,
    reset() {
      docMock.mockClear()
      getDocMock.mockClear()
      dataByPath.clear()
    },
  }
})

const activeStoreMocks = vi.hoisted(() => ({
  persistActiveStoreIdForUser: vi.fn(),
  clearActiveStoreIdForUser: vi.fn(),
}))

vi.mock('./firebase', () => ({
  auth: authMocks.auth,
  db: {},
}))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: User | null) => void) => {
    authMocks.listeners.push(callback)
    callback(authMocks.auth.currentUser)
    return () => {}
  },
  signOut: (...args: unknown[]) => authMocks.signOut(...args),
}))

vi.mock('firebase/firestore', () => ({
  doc: (...args: Parameters<typeof firestoreMocks.docMock>) =>
    firestoreMocks.docMock(...args),
  getDoc: (...args: Parameters<typeof firestoreMocks.getDocMock>) =>
    firestoreMocks.getDocMock(...args),
  collection: vi.fn(),
  getDocs: vi.fn(async () => ({ docs: [] })),
  query: vi.fn(),
  where: vi.fn(),
}))

vi.mock('./utils/activeStoreStorage', () => ({
  persistActiveStoreIdForUser: (...args: unknown[]) =>
    activeStoreMocks.persistActiveStoreIdForUser(...args),
  clearActiveStoreIdForUser: (...args: unknown[]) =>
    activeStoreMocks.clearActiveStoreIdForUser(...args),
}))

function createUser(): User {
  return {
    uid: 'test-user',
    email: 'user@example.com',
  } as unknown as User
}

describe('SheetAccessGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.listeners.splice(0, authMocks.listeners.length)
    firestoreMocks.reset()
    authMocks.auth.currentUser = null
  })

  it('grants access when the override document contains the workspace assignment', async () => {
    const user = createUser()
    authMocks.auth.currentUser = user

    if (!OVERRIDE_TEAM_MEMBER_DOC_ID) {
      throw new Error('Test requires a non-empty override document id')
    }

    firestoreMocks.dataByPath.set(`teamMembers/${OVERRIDE_TEAM_MEMBER_DOC_ID}`, {
      storeId: 'store-123',
      status: 'active',
      contractStatus: 'signed',
    })

    render(
      <SheetAccessGuard>
        <p>Child content</p>
      </SheetAccessGuard>,
    )

    await waitFor(() =>
      expect(screen.queryByText('Checking workspace access…')).not.toBeInTheDocument(),
    )

    expect(screen.getByText('Child content')).toBeInTheDocument()
    expect(authMocks.signOut).not.toHaveBeenCalled()
    expect(activeStoreMocks.persistActiveStoreIdForUser).toHaveBeenCalledWith(
      user.uid,
      'store-123',
    )
  })
})

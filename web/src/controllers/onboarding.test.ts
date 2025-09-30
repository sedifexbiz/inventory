import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'

const firestore = vi.hoisted(() => {
  const docDataByPath = new Map<string, Record<string, unknown>>()

  const docMock = vi.fn((_: unknown, ...segments: string[]) => {
    const path = segments.join('/')
    return { path }
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

  const getDocImplementation = async (ref: { path: string }) => {
    const stored = docDataByPath.get(ref.path)
    return {
      exists: () => stored !== undefined,
      data: () => (stored ? { ...stored } : undefined),
      get: (field: string) => (stored ? (stored as Record<string, unknown>)[field] : undefined),
    }
  }

  const setDocMock = vi.fn(setDocImplementation)
  const getDocMock = vi.fn(getDocImplementation)
  const serverTimestampMock = vi.fn(() => ({ __type: 'serverTimestamp', order: docDataByPath.size + 1 }))

  return {
    docMock,
    setDocMock,
    getDocMock,
    serverTimestampMock,
    docDataByPath,
    reset() {
      docMock.mockClear()
      setDocMock.mockClear()
      getDocMock.mockClear()
      serverTimestampMock.mockClear()
      docDataByPath.clear()
      getDocMock.mockImplementation(getDocImplementation)
    },
  }
})

const storage = vi.hoisted(() => ({
  persistActiveStoreIdForUser: vi.fn(),
}))

vi.mock('../firebase', () => ({
  db: {},
}))

vi.mock('firebase/firestore', () => ({
  doc: (...args: Parameters<typeof firestore.docMock>) => firestore.docMock(...args),
  setDoc: (...args: Parameters<typeof firestore.setDocMock>) => firestore.setDocMock(...args),
  getDoc: (...args: Parameters<typeof firestore.getDocMock>) => firestore.getDocMock(...args),
  serverTimestamp: (...args: Parameters<typeof firestore.serverTimestampMock>) =>
    firestore.serverTimestampMock(...args),
}))

vi.mock('../utils/activeStoreStorage', () => ({
  persistActiveStoreIdForUser: (
    ...args: Parameters<typeof storage.persistActiveStoreIdForUser>
  ) => storage.persistActiveStoreIdForUser(...args),
}))

import { createInitialOwnerAndStore } from './onboarding'

describe('createInitialOwnerAndStore', () => {
  beforeEach(() => {
    firestore.reset()
    storage.persistActiveStoreIdForUser.mockClear()
  })

  it('creates owner and store documents using the derived slug', async () => {
    const user = {
      uid: 'owner-1234567890',
      email: 'owner@example.com',
      displayName: 'Store Owner',
    } as unknown as User

    const storeId = await createInitialOwnerAndStore({
      user,
      email: 'custom-owner@example.com',
      role: 'staff',
      company: 'Sedifex Incorporated',
    })

    expect(storeId).toBe('sedifex-incorporated-owner-12')
    expect(storage.persistActiveStoreIdForUser).toHaveBeenCalledWith(user.uid, storeId)

    const teamMemberDoc = firestore.docDataByPath.get(`teamMembers/${user.uid}`)
    expect(teamMemberDoc).toMatchObject({
      uid: user.uid,
      storeId,
      role: 'staff',
      email: 'custom-owner@example.com',
      company: 'Sedifex Incorporated',
      name: 'Store Owner',
    })

    const storeDoc = firestore.docDataByPath.get(`stores/${storeId}`)
    expect(storeDoc).toMatchObject({
      storeId,
      ownerId: user.uid,
      ownerEmail: 'custom-owner@example.com',
      ownerName: 'Store Owner',
      company: 'Sedifex Incorporated',
    })
  })

  it('defaults role to owner and falls back to the user email for slug generation', async () => {
    const user = {
      uid: 'owner-1234567890',
      email: 'owner@example.com',
      displayName: null,
    } as unknown as User

    const storeId = await createInitialOwnerAndStore({
      user,
      company: null,
    })

    expect(storeId).toBe('owner-example-com-owner-12')
    expect(storage.persistActiveStoreIdForUser).toHaveBeenCalledWith(user.uid, storeId)

    const teamMemberDoc = firestore.docDataByPath.get(`teamMembers/${user.uid}`)
    expect(teamMemberDoc).toMatchObject({
      role: 'owner',
      email: 'owner@example.com',
    })

    const storeDoc = firestore.docDataByPath.get(`stores/${storeId}`)
    expect(storeDoc).toMatchObject({ ownerId: user.uid })
  })
})

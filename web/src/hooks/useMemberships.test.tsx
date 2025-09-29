import { describe, expect, it, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { useMemberships } from './useMemberships'

const mockUseAuthUser = vi.fn()
vi.mock('./useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

vi.mock('../firebase', () => ({
  db: {},
}))

const collectionMock = vi.fn(() => ({ type: 'collection' }))
const whereMock = vi.fn(() => ({ type: 'where' }))
const queryMock = vi.fn(() => ({ type: 'query' }))
const getDocsMock = vi.fn()

vi.mock('firebase/firestore', () => ({
  Timestamp: class MockTimestamp {},
  collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
  where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
  getDocs: (...args: Parameters<typeof getDocsMock>) => getDocsMock(...args),
}))

describe('useMemberships', () => {
  beforeEach(() => {
    mockUseAuthUser.mockReset()
    collectionMock.mockClear()
    whereMock.mockClear()
    queryMock.mockClear()
    getDocsMock.mockReset()
  })

  it('returns an empty membership list when the user is not authenticated', async () => {
    mockUseAuthUser.mockReturnValue(null)

    const { result } = renderHook(() => useMemberships(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.memberships).toEqual([])
    expect(collectionMock).not.toHaveBeenCalled()
  })

  it('loads memberships for the authenticated user and normalizes the document shape', async () => {
    mockUseAuthUser.mockReturnValue({ uid: 'user-123' })

    const membershipDoc = {
      id: 'member-doc',
      data: () => ({
        uid: 'user-123',
        role: 'staff',
        storeId: 'store-abc',
        email: 'member@example.com',
        phone: '+1234567890',
        invitedBy: 'owner-1',
        firstSignupEmail: 'owner@example.com',
        createdAt: null,
        updatedAt: null,
      }),
    }

    getDocsMock.mockResolvedValue({ docs: [membershipDoc] })

    const { result } = renderHook(() => useMemberships(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(collectionMock).toHaveBeenCalledWith({}, 'teamMembers')
    expect(whereMock).toHaveBeenCalledTimes(1)
    expect(whereMock).toHaveBeenCalledWith('uid', '==', 'user-123')
    expect(queryMock).toHaveBeenCalledWith({ type: 'collection' }, { type: 'where' })
    expect(getDocsMock).toHaveBeenCalled()

    expect(result.current.memberships).toEqual([
      {
        id: 'member-doc',
        uid: 'user-123',
        role: 'staff',
        storeId: 'store-abc',
        email: 'member@example.com',
        phone: '+1234567890',
        invitedBy: 'owner-1',
        firstSignupEmail: 'owner@example.com',
        createdAt: null,
        updatedAt: null,
      },
    ])
    expect(result.current.error).toBeNull()
  })

  it('falls back to the document id and null values when fields are missing', async () => {
    mockUseAuthUser.mockReturnValue({ uid: 'user-456' })

    const membershipDoc = {
      id: 'user-456',
      data: () => ({
        role: 'unknown-role',
      }),
    }

    getDocsMock.mockResolvedValue({ docs: [membershipDoc] })

    const { result } = renderHook(() => useMemberships(null))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.memberships).toEqual([
      {
        id: 'user-456',
        uid: 'user-456',
        role: 'staff',
        storeId: null,
        email: null,
        phone: null,
        invitedBy: null,
        firstSignupEmail: null,
        createdAt: null,
        updatedAt: null,
      },
    ])
  })

  it('filters memberships by active store when provided', async () => {
    mockUseAuthUser.mockReturnValue({ uid: 'user-789' })

    getDocsMock.mockResolvedValue({ docs: [] })

    renderHook(() => useMemberships('active-store'))

    await waitFor(() => {
      expect(queryMock).toHaveBeenCalled()
    })

    expect(whereMock).toHaveBeenNthCalledWith(1, 'uid', '==', 'user-789')
    expect(whereMock).toHaveBeenNthCalledWith(2, 'storeId', '==', 'active-store')
  })
})

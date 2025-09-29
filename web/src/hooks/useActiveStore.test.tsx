import { describe, beforeEach, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { useActiveStore } from './useActiveStore'

const mockUseMemberships = vi.fn()

vi.mock('./useMemberships', () => ({
  useMemberships: (storeId?: string | null) => mockUseMemberships(storeId),
}))

describe('useActiveStore', () => {
  beforeEach(() => {
    mockUseMemberships.mockReset()
    window.localStorage.clear()
  })

  it('prefers the persisted store id when it matches the membership store', async () => {
    mockUseMemberships.mockImplementation(storeId =>
      storeId === undefined
        ? { memberships: [], loading: true, error: null }
        : {
            memberships: [{ id: 'member-1', storeId: 'matching-store' }],
            loading: false,
            error: null,
          },
    )

    window.localStorage.setItem('activeStoreId', 'matching-store')

    const { result } = renderHook(() => useActiveStore())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.storeId).toBe('matching-store')
    expect(result.current.error).toBeNull()
  })

  it('updates the persisted store id when membership store differs', async () => {
    mockUseMemberships.mockImplementation(storeId =>
      storeId === undefined
        ? { memberships: [], loading: true, error: null }
        : {
            memberships: [{ id: 'member-1', storeId: 'membership-store' }],
            loading: false,
            error: null,
          },
    )

    window.localStorage.setItem('activeStoreId', 'persisted-store')

    const { result } = renderHook(() => useActiveStore())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
      expect(result.current.storeId).toBe('membership-store')
    })

    expect(window.localStorage.getItem('activeStoreId')).toBe('membership-store')
  })

  it('falls back to the membership store id when nothing is persisted', async () => {
    mockUseMemberships.mockImplementation(storeId =>
      storeId === undefined
        ? { memberships: [], loading: true, error: null }
        : {
            memberships: [
              { id: 'member-1', storeId: 'membership-store' },
              { id: 'member-2', storeId: 'membership-store-2' },
            ],
            loading: false,
            error: null,
          },
    )

    const { result } = renderHook(() => useActiveStore())

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.storeId).toBe('membership-store')
  })
})

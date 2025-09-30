import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import Shell from './Shell'

const mockUseAuthUser = vi.fn()
const mockUseConnectivityStatus = vi.fn()
const mockUseActiveStoreContext = vi.fn()

vi.mock('../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

vi.mock('../hooks/useConnectivityStatus', () => ({
  useConnectivityStatus: () => mockUseConnectivityStatus(),
}))

vi.mock('../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

vi.mock('../firebase', () => ({
  auth: {},
}))

vi.mock('firebase/auth', () => ({
  signOut: vi.fn(),
}))

function renderShell() {
  return render(
    <MemoryRouter>
      <Shell>
        <div>Content</div>
      </Shell>
    </MemoryRouter>,
  )
}

describe('Shell', () => {
  beforeEach(() => {
    mockUseAuthUser.mockReset()
    mockUseConnectivityStatus.mockReset()
    mockUseActiveStoreContext.mockReset()

    mockUseAuthUser.mockReturnValue({ email: 'owner@example.com' })
    mockUseConnectivityStatus.mockReturnValue({
      isOnline: true,
      isReachable: true,
      isChecking: false,
      lastHeartbeatAt: null,
      heartbeatError: null,
      queue: { status: 'idle', pending: 0, lastError: null, updatedAt: null },
    })
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-1',
      isLoading: false,
      error: null,
      memberships: [
        {
          id: 'membership-1',
          uid: 'user-1',
          role: 'owner',
          storeId: 'store-1',
          email: null,
          phone: null,
          invitedBy: null,
          firstSignupEmail: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })
  })

  it('renders the workspace status', () => {
    renderShell()

    expect(screen.getByText('Workspace ready')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /workspace/i })).toHaveValue('store-1')

  })
})

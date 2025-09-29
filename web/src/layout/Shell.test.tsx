import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import Shell from './Shell'

const mockUseAuthUser = vi.fn()
const mockUseConnectivityStatus = vi.fn()

vi.mock('../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

vi.mock('../hooks/useConnectivityStatus', () => ({
  useConnectivityStatus: () => mockUseConnectivityStatus(),
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

    mockUseAuthUser.mockReturnValue({ email: 'owner@example.com' })
    mockUseConnectivityStatus.mockReturnValue({
      isOnline: true,
      isReachable: true,
      isChecking: false,
      lastHeartbeatAt: null,
      heartbeatError: null,
      queue: { status: 'idle', pending: 0, lastError: null, updatedAt: null },
    })
  })

  it('renders the workspace status', () => {
    renderShell()

    expect(screen.getByText('Workspace ready')).toBeInTheDocument()

  })
})

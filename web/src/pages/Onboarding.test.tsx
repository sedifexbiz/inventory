import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import Onboarding from './Onboarding'

const mockUseAuthUser = vi.fn()
vi.mock('../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

const mockUseActiveStore = vi.fn()
vi.mock('../hooks/useActiveStore', () => ({
  useActiveStore: () => mockUseActiveStore(),
}))

const mockGetOnboardingStatus = vi.fn()
const mockSetOnboardingStatus = vi.fn()
vi.mock('../utils/onboarding', () => ({
  getOnboardingStatus: (...args: Parameters<typeof mockGetOnboardingStatus>) =>
    mockGetOnboardingStatus(...args),
  setOnboardingStatus: (...args: Parameters<typeof mockSetOnboardingStatus>) =>
    mockSetOnboardingStatus(...args),
}))

describe('Onboarding page', () => {
  beforeEach(() => {
    mockUseAuthUser.mockReset()
    mockUseActiveStore.mockReset()
    mockGetOnboardingStatus.mockReset()
    mockSetOnboardingStatus.mockReset()

    mockUseAuthUser.mockReturnValue({
      uid: 'store-123',
      email: 'owner@example.com',
    })

    mockUseActiveStore.mockReturnValue({
      storeId: 'store-123',
      stores: ['store-123'],
      isLoading: false,
      error: null,
      selectStore: vi.fn(),
    })

    mockGetOnboardingStatus.mockReturnValue('pending')
  })

  it('renders onboarding content when store access is ready', () => {
    render(
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: /welcome to sedifex/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /confirm your owner account/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open staff access settings/i })).toBeInTheDocument()
  })
})

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'

import Onboarding from './Onboarding'

const mockUseAuthUser = vi.fn()
vi.mock('../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
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
    mockGetOnboardingStatus.mockReset()
    mockSetOnboardingStatus.mockReset()

    mockUseAuthUser.mockReturnValue({
      uid: 'user-123',
      email: 'owner@example.com',
    })

    mockGetOnboardingStatus.mockReturnValue('pending')
  })

  it('renders onboarding content when workspace access is ready', () => {
    render(
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: /welcome to sedifex/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /confirm your owner account/i })).toBeInTheDocument()
    expect(screen.getByText(/need to update access later/i)).toBeInTheDocument()
    expect(screen.getByText(/let's get your workspace ready/i)).toBeInTheDocument()
  })
})

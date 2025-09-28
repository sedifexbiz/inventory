import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AccountOverview from '../AccountOverview'

const mockPublish = vi.fn()

vi.mock('../../components/ToastProvider', () => ({
  useToast: () => ({ publish: mockPublish }),
}))

const mockUseActiveStore = vi.fn()
vi.mock('../../hooks/useActiveStore', () => ({
  useActiveStore: () => mockUseActiveStore(),
}))

const mockUseMemberships = vi.fn()
vi.mock('../../hooks/useMemberships', () => ({
  useMemberships: () => mockUseMemberships(),
}))

const mockManageStaffAccount = vi.fn()
vi.mock('../../controllers/storeController', () => ({
  manageStaffAccount: (...args: Parameters<typeof mockManageStaffAccount>) =>
    mockManageStaffAccount(...args),
}))

const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const docMock = vi.fn((_db: unknown, path: string, id?: string) => ({
  type: 'doc',
  path: id ? `${path}/${id}` : path,
}))
const getDocMock = vi.fn()
const getDocsMock = vi.fn()
const queryMock = vi.fn((ref: unknown, ...clauses: unknown[]) => ({ ref, clauses }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }))

vi.mock('firebase/firestore', () => ({
  Timestamp: class {},
  collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
  doc: (...args: Parameters<typeof docMock>) => docMock(...args),
  getDoc: (...args: Parameters<typeof getDocMock>) => getDocMock(...args),
  getDocs: (...args: Parameters<typeof getDocsMock>) => getDocsMock(...args),
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
  where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
}))

vi.mock('../../firebase', () => ({
  db: {},
}))

const originalConsoleError = console.error
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null

beforeAll(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const [first] = args
    if (typeof first === 'string' && first.includes('act(...)')) {
      return
    }

    originalConsoleError(...(args as Parameters<typeof console.error>))
  })
})

afterAll(() => {
  consoleErrorSpy?.mockRestore()
})

describe('AccountOverview', () => {
  beforeEach(() => {
    mockPublish.mockReset()
    mockUseActiveStore.mockReset()
    mockUseMemberships.mockReset()
    mockManageStaffAccount.mockReset()
    collectionMock.mockClear()
    docMock.mockClear()
    getDocMock.mockReset()
    getDocsMock.mockReset()
    queryMock.mockClear()
    whereMock.mockClear()

    mockUseActiveStore.mockReturnValue({ storeId: 'store-123', isLoading: false, error: null })
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        displayName: 'Sedifex Coffee',
        status: 'Active',
        currency: 'GHS',
        billingPlan: 'Monthly',
        paymentProvider: 'Stripe',
        createdAt: { toDate: () => new Date('2023-01-01T00:00:00Z') },
        updatedAt: { toDate: () => new Date('2023-02-01T00:00:00Z') },
      }),
    })
    getDocsMock.mockResolvedValue({
      docs: [
        {
          id: 'member-1',
          data: () => ({
            email: 'owner@example.com',
            role: 'owner',
            invitedBy: 'admin@example.com',
            updatedAt: { toDate: () => new Date('2023-02-01T00:00:00Z') },
          }),
        },
      ],
    })
  })

  it('allows owners to manage team invitations', async () => {
    mockUseMemberships.mockReturnValue({
      memberships: [
        {
          id: 'm-1',
          uid: 'owner-1',
          role: 'owner',
          storeId: 'store-123',
          email: 'owner@example.com',
          phone: null,
          invitedBy: null,
          firstSignupEmail: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      loading: false,
      error: null,
    })

    render(<AccountOverview />)
    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    const form = await screen.findByTestId('account-invite-form')
    expect(form).toBeInTheDocument()

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'new-user@example.com')
    await user.selectOptions(screen.getByLabelText(/role/i), 'staff')
    await user.type(screen.getByLabelText(/password/i), 'Secret123!')
    await user.click(screen.getByRole('button', { name: /send invite/i }))

    await waitFor(() => {
      expect(mockManageStaffAccount).toHaveBeenCalledWith({
        storeId: 'store-123',
        email: 'new-user@example.com',
        role: 'staff',
        password: 'Secret123!',
      })
    })

    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(2))
    expect(mockPublish).toHaveBeenCalledWith({ message: 'Team member updated.', tone: 'success' })
  })

  it('renders a read-only roster for staff members', async () => {
    mockUseMemberships.mockReturnValue({
      memberships: [
        {
          id: 'm-2',
          uid: 'staff-1',
          role: 'staff',
          storeId: 'store-123',
          email: 'staff@example.com',
          phone: null,
          invitedBy: null,
          firstSignupEmail: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      loading: false,
      error: null,
    })

    render(<AccountOverview />)
    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    expect(screen.queryByTestId('account-invite-form')).not.toBeInTheDocument()
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument()
  })
})

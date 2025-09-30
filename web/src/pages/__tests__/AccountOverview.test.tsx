import React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AccountOverview from '../AccountOverview'
import { DEFAULT_CURRENCY_CODE } from '@shared/currency'

const mockPublish = vi.fn()

vi.mock('../../components/ToastProvider', () => ({
  useToast: () => ({ publish: mockPublish }),
}))

const mockUseActiveStoreContext = vi.fn()
vi.mock('../../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

const mockUseMemberships = vi.fn()
vi.mock('../../hooks/useMemberships', () => ({
  useMemberships: (storeId?: string | null) => mockUseMemberships(storeId),
}))

const mockManageStaffAccount = vi.fn()
const mockUpdateStoreProfile = vi.fn()
const mockRevokeStaffAccess = vi.fn()
vi.mock('../../controllers/storeController', () => ({
  manageStaffAccount: (...args: Parameters<typeof mockManageStaffAccount>) =>
    mockManageStaffAccount(...args),
  updateStoreProfile: (...args: Parameters<typeof mockUpdateStoreProfile>) =>
    mockUpdateStoreProfile(...args),
  revokeStaffAccess: (...args: Parameters<typeof mockRevokeStaffAccess>) =>
    mockRevokeStaffAccess(...args),
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
    mockUseActiveStoreContext.mockReset()
    mockUseMemberships.mockReset()
    mockManageStaffAccount.mockReset()
    mockUpdateStoreProfile.mockReset()
    mockRevokeStaffAccess.mockReset()
    collectionMock.mockClear()
    docMock.mockClear()
    getDocMock.mockReset()
    getDocsMock.mockReset()
    queryMock.mockClear()
    whereMock.mockClear()

    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-123',
      isLoading: false,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({
        name: 'Sedifex Coffee',
        displayName: 'Sedifex Coffee',
        company: 'Sedifex',
        status: 'Active',
        contractStatus: 'Active',
        contractStart: '2023-01-01',
        contractEnd: '2023-12-31',
        paymentStatus: 'Paid',
        amountPaid: 1000,
        currency: DEFAULT_CURRENCY_CODE,
        timezone: 'Africa/Accra',
        billingPlan: 'Monthly',
        paymentProvider: 'Stripe',
        createdAt: { toDate: () => new Date('2023-01-01T00:00:00Z') },
        updatedAt: { toDate: () => new Date('2023-02-01T00:00:00Z') },
      }),
    })
    getDocsMock.mockResolvedValue({
      docs: [
        {
          id: 'owner-1',
          data: () => ({
            email: 'owner@example.com',
            role: 'owner',
            invitedBy: 'admin@example.com',
            updatedAt: { toDate: () => new Date('2023-02-01T00:00:00Z') },
            lastSeenAt: { toDate: () => new Date('2023-02-02T10:00:00Z') },
          }),
        },
        {
          id: 'member-2',
          data: () => ({
            email: 'staff@example.com',
            role: 'staff',
            invitedBy: 'owner@example.com',
            updatedAt: { toDate: () => new Date('2023-02-03T00:00:00Z') },
            lastSeenAt: null,
          }),
        },
      ],
    })
    mockUpdateStoreProfile.mockResolvedValue({ ok: true, storeId: 'store-123' })
  })

  it('allows owners to update the store profile and manage team invitations', async () => {
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

    const user = userEvent.setup()

    await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    const expectedLastSeen = new Date('2023-02-02T10:00:00Z').toLocaleString()
    expect(screen.getByRole('columnheader', { name: /last seen/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /actions/i })).toBeInTheDocument()
    expect(screen.getByText(expectedLastSeen)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /revoke access/i })).toHaveLength(1)


    expect(screen.getByText('store-123')).toBeInTheDocument()
    expect(screen.getByText('Sedifex')).toBeInTheDocument()
    expect(screen.getByText('2023-01-01')).toBeInTheDocument()
    expect(screen.getByText('2023-12-31')).toBeInTheDocument()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getByText('1000')).toBeInTheDocument()

    const form = await screen.findByTestId('account-invite-form')
    expect(form).toBeInTheDocument()

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

  it('revokes staff access after confirmation', async () => {
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

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockRevokeStaffAccess.mockResolvedValue({ ok: true, storeId: 'store-123', uid: 'member-2' })

    render(<AccountOverview />)
    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    const staffRow = await screen.findByTestId('account-roster-member-2')
    const revokeButton = within(staffRow).getByRole('button', { name: /revoke access/i })

    const user = userEvent.setup()
    await user.click(revokeButton)

    expect(confirmSpy).toHaveBeenCalledWith('Revoke access for staff@example.com?')

    await waitFor(() =>
      expect(mockRevokeStaffAccess).toHaveBeenCalledWith({ storeId: 'store-123', uid: 'member-2' }),
    )

    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(2))
    expect(mockPublish).toHaveBeenCalledWith({ message: 'Team member access revoked.', tone: 'success' })

    confirmSpy.mockRestore()
  })

  it('prevents profile updates when required fields are missing', async () => {
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

    const workspaceInput = await screen.findByLabelText(/workspace name/i)
    const timezoneInput = screen.getByLabelText(/timezone/i)
    const currencyInput = screen.getByLabelText(/currency/i)

    const user = userEvent.setup()
    await user.clear(workspaceInput)
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(mockUpdateStoreProfile).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(mockPublish).toHaveBeenCalledWith({ message: 'Enter a workspace name.', tone: 'error' }),
    )

    await user.type(workspaceInput, 'Sedifex Coffee')
    await user.clear(timezoneInput)
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(mockUpdateStoreProfile).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(mockPublish).toHaveBeenCalledWith({ message: 'Enter a valid timezone.', tone: 'error' }),
    )

    await user.type(timezoneInput, 'Africa/Accra')
    await user.clear(currencyInput)
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    expect(mockUpdateStoreProfile).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(mockPublish).toHaveBeenCalledWith({ message: 'Enter a currency code.', tone: 'error' }),
    )
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

    getDocsMock.mockResolvedValueOnce({
      docs: [
        {
          id: 'member-1',
          data: () => ({
            email: 'staff@example.com',
            role: 'staff',
            invitedBy: null,
            createdAt: { toDate: () => new Date('2023-01-10T12:00:00Z') },
          }),
        },
      ],
    })

    render(<AccountOverview />)
    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    expect(screen.queryByTestId('account-invite-form')).not.toBeInTheDocument()
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument()


    const row = await screen.findByTestId('account-roster-member-1')
    const cells = within(row).getAllByRole('cell')
    expect(cells).toHaveLength(5)
    const expectedFallbackLastSeen = new Date('2023-01-10T12:00:00Z').toLocaleString()
    expect(cells[4]).toHaveTextContent(expectedFallbackLastSeen)

  })
})

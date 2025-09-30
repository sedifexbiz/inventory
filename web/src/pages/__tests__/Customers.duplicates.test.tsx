import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import Customers from '../Customers'

const mockLoadCachedCustomers = vi.fn(async () => [] as unknown[])
const mockSaveCachedCustomers = vi.fn(async () => {})
const mockLoadCachedSales = vi.fn(async () => [] as unknown[])
const mockSaveCachedSales = vi.fn(async () => {})

vi.mock('../../utils/offlineCache', () => ({
  CUSTOMER_CACHE_LIMIT: 200,
  SALES_CACHE_LIMIT: 200,
  loadCachedCustomers: (
    ...args: Parameters<typeof mockLoadCachedCustomers>
  ) => mockLoadCachedCustomers(...args),
  saveCachedCustomers: (
    ...args: Parameters<typeof mockSaveCachedCustomers>
  ) => mockSaveCachedCustomers(...args),
  loadCachedSales: (
    ...args: Parameters<typeof mockLoadCachedSales>
  ) => mockLoadCachedSales(...args),
  saveCachedSales: (
    ...args: Parameters<typeof mockSaveCachedSales>
  ) => mockSaveCachedSales(...args),
}))

vi.mock('../../firebase', () => ({
  db: {},
}))

const mockUseActiveStoreContext = vi.fn(() => ({
  storeId: 'store-123',
  isLoading: false,
  error: null,
  memberships: [],
  membershipsLoading: false,
  setActiveStoreId: vi.fn(),
  storeChangeToken: 0,
}))

vi.mock('../../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({
  type: 'where',
  field,
  op,
  value,
}))
const orderByMock = vi.fn((field: string, direction?: string) => ({ type: 'orderBy', field, direction }))
const limitMock = vi.fn((value: number) => ({ type: 'limit', value }))
const queryMock = vi.fn((collectionRef: { path: string }, ...clauses: unknown[]) => ({
  collection: collectionRef,
  clauses,
}))

let customerDocs: Array<{ id: string; data: () => Record<string, unknown> }> = []

const onSnapshotMock = vi.fn(
  (
    queryRef: { collection: { path: string } },
    onNext: (snapshot: { docs: typeof customerDocs }) => void,
  ) => {
    queueMicrotask(() => {
      if (queryRef.collection.path === 'customers') {
        onNext({ docs: customerDocs })
      }
      if (queryRef.collection.path === 'sales') {
        onNext({ docs: [] })
      }
    })
    return () => {}
  },
)

const addDocMock = vi.fn(async () => ({ id: 'new-customer-id' }))
const updateDocMock = vi.fn(async () => {})
const deleteDocMock = vi.fn(async () => {})

const docMock = vi.fn((...args: unknown[]) => {
  if (args.length === 3) {
    const [, collectionPath, id] = args as [unknown, string, string]
    return { type: 'doc', path: `${collectionPath}/${id}`, id }
  }
  throw new Error('Unexpected doc invocation in test')
})

const serverTimestampMock = vi.fn(() => 'mock-server-timestamp')

vi.mock('firebase/firestore', () => ({
  collection: (
    ...args: Parameters<typeof collectionMock>
  ) => collectionMock(...args),
  query: (
    ...args: Parameters<typeof queryMock>
  ) => queryMock(...args),
  orderBy: (
    ...args: Parameters<typeof orderByMock>
  ) => orderByMock(...args),
  limit: (
    ...args: Parameters<typeof limitMock>
  ) => limitMock(...args),
  where: (
    ...args: Parameters<typeof whereMock>
  ) => whereMock(...args),
  onSnapshot: (
    ...args: Parameters<typeof onSnapshotMock>
  ) => onSnapshotMock(...args),
  addDoc: (
    ...args: Parameters<typeof addDocMock>
  ) => addDocMock(...args),
  updateDoc: (
    ...args: Parameters<typeof updateDocMock>
  ) => updateDocMock(...args),
  deleteDoc: (
    ...args: Parameters<typeof deleteDocMock>
  ) => deleteDocMock(...args),
  doc: (
    ...args: Parameters<typeof docMock>
  ) => docMock(...args),
  serverTimestamp: (
    ...args: Parameters<typeof serverTimestampMock>
  ) => serverTimestampMock(...args),
}))

describe('Customers duplicate handling', () => {
  beforeEach(() => {
    customerDocs = []
    addDocMock.mockClear()
    updateDocMock.mockClear()
    serverTimestampMock.mockClear()
    mockLoadCachedCustomers.mockClear()
    mockSaveCachedCustomers.mockClear()
    mockLoadCachedSales.mockClear()
    mockSaveCachedSales.mockClear()
  })

  it('updates an existing customer when the email matches', async () => {
    customerDocs = [
      {
        id: 'customer-1',
        data: () => ({
          id: 'customer-1',
          name: 'Existing Customer',
          email: 'ada@example.com',
          storeId: 'store-123',
        }),
      },
    ]

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Customers />
      </MemoryRouter>,
    )

    const nameInput = await screen.findByLabelText(/Full name/i)
    await user.clear(nameInput)
    await user.type(nameInput, 'Ada Lovelace')

    const emailInput = screen.getByLabelText(/Email/i)
    await user.clear(emailInput)
    await user.type(emailInput, 'ada@example.com')

    const submitButton = screen.getByRole('button', { name: /Save customer/i })
    await user.click(submitButton)

    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1))
    expect(addDocMock).not.toHaveBeenCalled()
    expect(updateDocMock.mock.calls[0]?.[0]).toEqual({
      type: 'doc',
      path: 'customers/customer-1',
      id: 'customer-1',
    })
    expect(updateDocMock.mock.calls[0]?.[1]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      storeId: 'store-123',
    })

    await screen.findByText('Customer already exists. Updated their details instead.')
  })

  it('updates an existing customer when the normalized phone matches', async () => {
    customerDocs = [
      {
        id: 'customer-9',
        data: () => ({
          id: 'customer-9',
          name: 'Kwame Asante',
          phone: '020 000 0000',
          storeId: 'store-123',
        }),
      },
    ]

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Customers />
      </MemoryRouter>,
    )

    const nameInput = await screen.findByLabelText(/Full name/i)
    await user.clear(nameInput)
    await user.type(nameInput, 'Kwame Asante')

    const phoneInput = screen.getByLabelText(/Phone/i)
    await user.clear(phoneInput)
    await user.type(phoneInput, '020-000-0000')

    const submitButton = screen.getByRole('button', { name: /Save customer/i })
    await user.click(submitButton)

    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1))
    expect(addDocMock).not.toHaveBeenCalled()
    expect(updateDocMock.mock.calls[0]?.[0]).toEqual({
      type: 'doc',
      path: 'customers/customer-9',
      id: 'customer-9',
    })
    expect(updateDocMock.mock.calls[0]?.[1]).toMatchObject({
      phone: '020-000-0000',
      name: 'Kwame Asante',
      storeId: 'store-123',
    })

    await screen.findByText('Customer already exists. Updated their details instead.')
  })

  it('includes loyalty defaults when creating a new customer', async () => {
    customerDocs = []

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Customers />
      </MemoryRouter>,
    )

    const nameInput = await screen.findByLabelText(/Full name/i)
    await user.clear(nameInput)
    await user.type(nameInput, 'New Customer')

    const submitButton = screen.getByRole('button', { name: /Save customer/i })
    await user.click(submitButton)

    await waitFor(() => expect(addDocMock).toHaveBeenCalledTimes(1))
    const payload = addDocMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.loyalty).toEqual({ points: 0, lastVisitAt: null })
  })
})

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { formatCurrency } from '@shared/currency'
import Sell from '../Sell'

const mockLoadCachedProducts = vi.fn(async () => [] as unknown[])
const mockSaveCachedProducts = vi.fn(async () => {})
const mockLoadCachedCustomers = vi.fn(async () => [] as unknown[])
const mockSaveCachedCustomers = vi.fn(async () => {})

vi.mock('../../utils/offlineCache', () => ({
  PRODUCT_CACHE_LIMIT: 200,
  CUSTOMER_CACHE_LIMIT: 200,
  loadCachedProducts: (...args: Parameters<typeof mockLoadCachedProducts>) =>
    mockLoadCachedProducts(...args),
  saveCachedProducts: (...args: Parameters<typeof mockSaveCachedProducts>) =>
    mockSaveCachedProducts(...args),
  loadCachedCustomers: (...args: Parameters<typeof mockLoadCachedCustomers>) =>
    mockLoadCachedCustomers(...args),
  saveCachedCustomers: (...args: Parameters<typeof mockSaveCachedCustomers>) =>
    mockSaveCachedCustomers(...args),
}))

vi.mock('../../utils/pdf', () => ({
  buildSimplePdf: vi.fn(() => new Uint8Array([0, 1, 2, 3])),
}))

vi.mock('../../firebase', () => ({
  db: {},
}))

const mockUseAuthUser = vi.fn(() => ({ uid: 'user-1', email: 'cashier@example.com' }))
vi.mock('../../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

const mockUseActiveStoreContext = vi.fn(() => ({
  storeId: 'store-1',
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
const onSnapshotMock = vi.fn(
  (
    queryRef: { collection: { path: string } },
    onNext: (snapshot: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void,
  ) => {
    queueMicrotask(() => {
      onNext({ docs: [] })
    })
    return () => {}
  },
)
const docMock = vi.fn((...args: unknown[]) => {
  if (args.length === 1) {
    const [collectionRef] = args as [{ path: string }]
    return { type: 'doc', path: `${collectionRef.path}/auto-id`, id: 'auto-id' }
  }
  if (args.length === 2) {
    const [collectionRef, id] = args as [{ path: string }, string]
    return { type: 'doc', path: `${collectionRef.path}/${id}`, id }
  }
  if (args.length === 3) {
    const [, collectionPath, id] = args as [unknown, string, string]
    return { type: 'doc', path: `${collectionPath}/${id}`, id }
  }
  throw new Error('Unexpected doc invocation in test')
})
const runTransactionMock = vi.fn(async () => {})
const serverTimestampMock = vi.fn(() => 'server-timestamp')

vi.mock('firebase/firestore', () => ({
  collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
  orderBy: (...args: Parameters<typeof orderByMock>) => orderByMock(...args),
  limit: (...args: Parameters<typeof limitMock>) => limitMock(...args),
  onSnapshot: (...args: Parameters<typeof onSnapshotMock>) => onSnapshotMock(...args),
  where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
  doc: (...args: Parameters<typeof docMock>) => docMock(...args),
  runTransaction: (...args: Parameters<typeof runTransactionMock>) => runTransactionMock(...args),
  serverTimestamp: () => serverTimestampMock(),
}))

function createProductDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    data: () => ({
      name: 'Test Product',
      sku: '12345',
      price: 8,
      stockCount: 5,
      ...overrides,
    }),
  }
}

describe('Sell page barcode scanner', () => {
  beforeEach(() => {
    mockLoadCachedProducts.mockReset()
    mockSaveCachedProducts.mockReset()
    mockLoadCachedCustomers.mockReset()
    mockSaveCachedCustomers.mockReset()
    collectionMock.mockClear()
    queryMock.mockClear()
    orderByMock.mockClear()
    limitMock.mockClear()
    onSnapshotMock.mockClear()
    whereMock.mockClear()
    docMock.mockClear()
    runTransactionMock.mockReset()
    runTransactionMock.mockImplementation(async () => {})
    mockUseAuthUser.mockReset()
    mockUseAuthUser.mockReturnValue({ uid: 'user-1', email: 'cashier@example.com' })
    mockUseActiveStoreContext.mockReset()
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-1',
      isLoading: false,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })

    mockLoadCachedProducts.mockResolvedValue([])
    mockLoadCachedCustomers.mockResolvedValue([])
    mockSaveCachedProducts.mockResolvedValue(undefined)
    mockSaveCachedCustomers.mockResolvedValue(undefined)

    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      queueMicrotask(() => {
        onNext({ docs: [] })
      })
      return () => {}
    })

    if (typeof URL.createObjectURL !== 'function') {
      // @ts-expect-error - jsdom does not implement createObjectURL
      URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      // @ts-expect-error - jsdom does not implement revokeObjectURL
      URL.revokeObjectURL = vi.fn()
    }
  })

  it('adds a matching product to the cart when a barcode is scanned', async () => {
    let productSnapshot: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null =
      null

    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      if (queryRef.collection.path === 'products') {
        productSnapshot = onNext
      }
      queueMicrotask(() => {
        onNext({ docs: [] })
      })
      return () => {}
    })

    render(
      <MemoryRouter>
        <Sell />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())

    await waitFor(() => expect(productSnapshot).toBeTruthy())

    await act(async () => {
      productSnapshot?.({ docs: [createProductDoc('product-1', { sku: 'ABC-123', price: 10 })] })
    })

    fireEvent.keyDown(window, { key: 'A' })
    fireEvent.keyDown(window, { key: 'B' })
    fireEvent.keyDown(window, { key: 'C' })
    fireEvent.keyDown(window, { key: '-' })
    fireEvent.keyDown(window, { key: '1' })
    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: '3' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(await screen.findByText(/added test product via the scanner/i)).toBeInTheDocument()

    const cart = screen.getByLabelText('Cart')
    await waitFor(() => {
      const rows = within(cart).getAllByRole('row')
      expect(rows).toHaveLength(2)
      expect(within(rows[1]).getByText('Test Product')).toBeInTheDocument()
      expect(within(rows[1]).getByText(formatCurrency(10))).toBeInTheDocument()
    })
  })

  it('shows an error when a scanned code is unknown', async () => {
    let productSnapshot: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null =
      null

    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      if (queryRef.collection.path === 'products') {
        productSnapshot = onNext
      }
      queueMicrotask(() => {
        onNext({ docs: [] })
      })
      return () => {}
    })

    render(
      <MemoryRouter>
        <Sell />
      </MemoryRouter>,
    )

    await waitFor(() => expect(productSnapshot).toBeTruthy())

    await act(async () => {
      productSnapshot?.({ docs: [createProductDoc('product-2', { sku: 'KNOWN-1', price: 5 })] })
    })

    fireEvent.keyDown(window, { key: '9' })
    fireEvent.keyDown(window, { key: '9' })
    fireEvent.keyDown(window, { key: '9' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(await screen.findByText(/we couldn't find a product for code 999/i)).toBeInTheDocument()
  })

  it('accepts manual barcode entry as a fallback', async () => {
    const user = userEvent.setup()
    let productSnapshot: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null =
      null

    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      if (queryRef.collection.path === 'products') {
        productSnapshot = onNext
      }
      queueMicrotask(() => {
        onNext({ docs: [] })
      })
      return () => {}
    })

    render(
      <MemoryRouter>
        <Sell />
      </MemoryRouter>,
    )

    await waitFor(() => expect(productSnapshot).toBeTruthy())

    await act(async () => {
      productSnapshot?.({ docs: [createProductDoc('product-3', { sku: '654321', price: 7 })] })
    })

    const input = await screen.findByLabelText('Scan or type a barcode')
    await user.type(input, '654321')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    expect(await screen.findByText(/added test product via manual entry/i)).toBeInTheDocument()

    const cart = screen.getByLabelText('Cart')
    await waitFor(() => {
      const rows = within(cart).getAllByRole('row')
      expect(rows).toHaveLength(2)
      expect(within(rows[1]).getByText('Test Product')).toBeInTheDocument()
      expect(within(rows[1]).getByText(formatCurrency(7))).toBeInTheDocument()
    })
  })

  it('updates customer loyalty when recording a sale', async () => {
    const user = userEvent.setup()

    const customerDoc = {
      id: 'customer-1',
      data: () => ({
        name: 'Loyal Customer',
        loyalty: { points: 7, lastVisitAt: null },
        storeId: 'store-1',
      }),
    }

    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      queueMicrotask(() => {
        if (queryRef.collection.path === 'products') {
          onNext({ docs: [createProductDoc('product-1', { price: 10, stockCount: 5 })] })
        } else if (queryRef.collection.path === 'customers') {
          onNext({ docs: [customerDoc] })
        } else {
          onNext({ docs: [] })
        }
      })
      return () => {}
    })

    const sets: Array<{ ref: { path: string }; data: Record<string, unknown> }> = []
    const updates: Array<{ ref: { path: string }; data: Record<string, unknown> }> = []

    runTransactionMock.mockImplementation(async (_db, updater: unknown) => {
      if (typeof updater !== 'function') return
      await (updater as (transaction: unknown) => Promise<void> | void)({
        async get(ref: { path: string }) {
          if (ref.path.startsWith('sales/')) {
            return { exists: () => false }
          }
          if (ref.path === 'products/product-1') {
            return {
              exists: () => true,
              get: (field: string) => (field === 'stockCount' ? 5 : undefined),
              data: { stockCount: 5 },
            }
          }
          if (ref.path === 'customers/customer-1') {
            return {
              exists: () => true,
              data: () => ({ loyalty: { points: 7, lastVisitAt: null } }),
            }
          }
          return { exists: () => false, data: () => ({}) }
        },
        set(ref: { path: string }, data: Record<string, unknown>) {
          sets.push({ ref, data })
        },
        update(ref: { path: string }, data: Record<string, unknown>) {
          updates.push({ ref, data })
        },
      })
    })

    render(
      <MemoryRouter>
        <Sell />
      </MemoryRouter>,
    )

    const addButton = await screen.findByRole('button', { name: /Test Product/i })
    await user.click(addButton)

    const cashInput = await screen.findByLabelText(/Cash received/i)
    await user.clear(cashInput)
    await user.type(cashInput, '10')

    const customerSelect = screen.getByLabelText('Customer')
    await user.selectOptions(customerSelect, 'customer-1')

    const recordButton = screen.getByRole('button', { name: /Record sale/i })
    await user.click(recordButton)

    await waitFor(() => {
      expect(runTransactionMock).toHaveBeenCalled()
      const customerUpdate = updates.find(entry => entry.ref.path === 'customers/customer-1')
      expect(customerUpdate).toBeTruthy()
    })

    const customerUpdate = updates.find(entry => entry.ref.path === 'customers/customer-1')!
    expect(customerUpdate.data).toMatchObject({
      'loyalty.lastVisitAt': 'server-timestamp',
      'loyalty.points': 7,
      updatedAt: 'server-timestamp',
    })
    expect(sets.find(entry => entry.ref.path === 'customers/customer-1')).toBeFalsy()
  })
})

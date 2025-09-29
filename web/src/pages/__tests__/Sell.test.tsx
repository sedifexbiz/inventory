import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

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
  buildSimplePdf: vi.fn(async () => ({ blob: new Blob(), url: 'blob:test' })),
}))

vi.mock('../../firebase', () => ({
  db: {},
}))

const mockUseAuthUser = vi.fn(() => ({ uid: 'user-1', email: 'cashier@example.com' }))
vi.mock('../../hooks/useAuthUser', () => ({
  useAuthUser: () => mockUseAuthUser(),
}))

const mockUseActiveStoreContext = vi.fn(() => ({ storeId: 'store-1', isLoading: false, error: null }))
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
const docMock = vi.fn((collectionRef: { path: string }, id?: string) => ({
  type: 'doc',
  path: id ? `${collectionRef.path}/${id}` : `${collectionRef.path}/auto-id`,
  id: id ?? 'auto-id',
}))
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
    mockUseAuthUser.mockReset()
    mockUseAuthUser.mockReturnValue({ uid: 'user-1', email: 'cashier@example.com' })
    mockUseActiveStoreContext.mockReset()
    mockUseActiveStoreContext.mockReturnValue({ storeId: 'store-1', isLoading: false, error: null })

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
      expect(within(rows[1]).getByText(/GHS 10\.00/)).toBeInTheDocument()
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
      expect(within(rows[1]).getByText(/GHS 7\.00/)).toBeInTheDocument()
    })
  })
})

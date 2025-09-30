import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'

import Sell from './Sell'

const mockUseAuthUser = vi.fn()
vi.mock('../hooks/useAuthUser', () => ({
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
vi.mock('../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

const originalCreateObjectURL = globalThis.URL.createObjectURL
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL

beforeAll(() => {
  ;(globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:mock-url')
  ;(globalThis.URL as any).revokeObjectURL = vi.fn()
})

afterAll(() => {
  ;(globalThis.URL as any).createObjectURL = originalCreateObjectURL
  ;(globalThis.URL as any).revokeObjectURL = originalRevokeObjectURL
})

const mockLoadCachedProducts = vi.fn(async () => [] as unknown[])
const mockSaveCachedProducts = vi.fn(async () => {})
const mockLoadCachedCustomers = vi.fn(async () => [] as unknown[])
const mockSaveCachedCustomers = vi.fn(async () => {})

vi.mock('../utils/offlineCache', () => ({
  PRODUCT_CACHE_LIMIT: 200,
  CUSTOMER_CACHE_LIMIT: 200,
  loadCachedProducts: (
    ...args: Parameters<typeof mockLoadCachedProducts>
  ) => mockLoadCachedProducts(...args),
  saveCachedProducts: (
    ...args: Parameters<typeof mockSaveCachedProducts>
  ) => mockSaveCachedProducts(...args),
  loadCachedCustomers: (
    ...args: Parameters<typeof mockLoadCachedCustomers>
  ) => mockLoadCachedCustomers(...args),
  saveCachedCustomers: (
    ...args: Parameters<typeof mockSaveCachedCustomers>
  ) => mockSaveCachedCustomers(...args),
}))

vi.mock('../firebase', () => ({
  db: {},
}))

const productSnapshot = {
  docs: [
    {
      id: 'product-1',
      data: () => ({ id: 'product-1', name: 'Iced Coffee', price: 12 }),
    },
    {
      id: 'product-2',
      data: () => ({ id: 'product-2', name: 'Mystery Item' }),
    },
  ],
}

const customerSnapshot = {
  docs: [
    {
      id: 'customer-1',
      data: () => ({ id: 'customer-1', name: 'Ada Lovelace', phone: '+233200000000' }),
    },
  ],
}

type FakeCollectionRef = { type: 'collection'; path: string }
type FakeDocRef = { type: 'doc'; path: string; id: string; collectionPath: string }

const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const queryMock = vi.fn((collectionRef: { path: string }, ...clauses: unknown[]) => ({
  type: 'query',
  collection: collectionRef,
  clauses,
}))
const orderByMock = vi.fn((field: string, direction?: string) => ({ type: 'orderBy', field, direction }))
const limitMock = vi.fn((value: number) => ({ type: 'limit', value }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({ type: 'where', field, op, value }))

const onSnapshotMock = vi.fn((queryRef: { collection: { path: string } }, callback: (snap: unknown) => void) => {
  queueMicrotask(() => {
    if (queryRef.collection.path === 'products') {
      callback(productSnapshot)
    }
    if (queryRef.collection.path === 'customers') {
      callback(customerSnapshot)
    }
  })
  return () => {
    /* noop */
  }
})

let autoCounters: Record<string, number> = {}
const docMock = vi.fn((...args: unknown[]): FakeDocRef => {
  if (args.length === 1) {
    const collectionRef = args[0] as FakeCollectionRef
    const collectionPath = collectionRef.path
    if (collectionPath === 'sales') {
      return { type: 'doc', path: 'sales/sale-42', id: 'sale-42', collectionPath }
    }
    autoCounters[collectionPath] = (autoCounters[collectionPath] ?? 0) + 1
    const prefixMap: Record<string, string> = {
      saleItems: 'sale-item',
      stock: 'stock-entry',
      ledger: 'ledger-entry',
    }
    const prefix = prefixMap[collectionPath] ?? `${collectionPath}-auto`
    const id = `${prefix}-${autoCounters[collectionPath]}`
    return { type: 'doc', path: `${collectionPath}/${id}`, id, collectionPath }
  }

  if (args.length === 3) {
    const [, collectionPath, id] = args as [unknown, string, string]
    return { type: 'doc', path: `${collectionPath}/${id}`, id, collectionPath }
  }

  throw new Error('Unsupported doc invocation in test mock')
})

type RecordedOperation = { type: 'set' | 'update'; path: string; data: any }

let firestoreState: Record<string, any> = {}
let lastTransactionOperations: RecordedOperation[] = []

function createSnapshot(path: string, data: any) {
  return {
    exists: () => data !== undefined,
    data: () => data,
    get: (field: string) => (data ? data[field] : undefined),
    path,
  }
}

const runTransactionMock = vi.fn(async (_db: unknown, updater: any) => {
  const operations: RecordedOperation[] = []
  const transaction = {
    get: vi.fn(async (ref: FakeDocRef) => createSnapshot(ref.path, firestoreState[ref.path])),
    set: vi.fn((ref: FakeDocRef, data: any) => {
      operations.push({ type: 'set', path: ref.path, data })
      firestoreState[ref.path] = data
    }),
    update: vi.fn((ref: FakeDocRef, data: any) => {
      operations.push({ type: 'update', path: ref.path, data })
      firestoreState[ref.path] = { ...(firestoreState[ref.path] ?? {}), ...data }
    }),
  }

  const result = await updater(transaction)
  lastTransactionOperations = operations
  return result
})

const serverTimestampMock = vi.fn(() => 'server-timestamp')

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
  doc: (
    ...args: Parameters<typeof docMock>
  ) => docMock(...args),
  onSnapshot: (
    ...args: Parameters<typeof onSnapshotMock>
  ) => onSnapshotMock(...args),
  runTransaction: (
    ...args: Parameters<typeof runTransactionMock>
  ) => runTransactionMock(...args),
  serverTimestamp: () => serverTimestampMock(),
}))

function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> })
}

describe('Sell page', () => {
  beforeEach(() => {
    mockUseAuthUser.mockReset()
    mockUseActiveStoreContext.mockReset()
    mockUseAuthUser.mockReturnValue({
      uid: 'cashier-123',
      email: 'cashier@example.com',
    })
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-1',
      isLoading: false,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })

    autoCounters = {}
    firestoreState = {
      'products/product-1': { stockCount: 5, storeId: 'store-1', price: 12, name: 'Iced Coffee' },
    }
    lastTransactionOperations = []
    runTransactionMock.mockClear()
    serverTimestampMock.mockClear()
    mockLoadCachedProducts.mockReset()
    mockLoadCachedCustomers.mockReset()
    mockSaveCachedProducts.mockReset()
    mockSaveCachedCustomers.mockReset()
    mockLoadCachedProducts.mockResolvedValue([])
    mockLoadCachedCustomers.mockResolvedValue([])
    mockSaveCachedProducts.mockResolvedValue(undefined)
    mockSaveCachedCustomers.mockResolvedValue(undefined)
    collectionMock.mockClear()
    queryMock.mockClear()
    orderByMock.mockClear()
    limitMock.mockClear()
    docMock.mockClear()
    onSnapshotMock.mockClear()
  })

  it('records a cash sale with a Firestore transaction', async () => {
    const user = userEvent.setup()

    renderWithProviders(<Sell />)

    const productButton = await screen.findByRole('button', { name: /iced coffee/i })
    await user.click(productButton)

    const cashInput = screen.getByLabelText(/cash received/i)
    await user.clear(cashInput)
    await user.type(cashInput, '15')

    const recordButton = screen.getByRole('button', { name: /record sale/i })
    await user.click(recordButton)

    await waitFor(() => {
      expect(runTransactionMock).toHaveBeenCalledTimes(1)
    })

    const saleOperation = lastTransactionOperations.find(op => op.type === 'set' && op.path === 'sales/sale-42')
    expect(saleOperation?.data).toMatchObject({
      branchId: 'store-1',
      total: 12,
      tenders: { cash: 15 },
      changeDue: 3,
      items: [expect.objectContaining({ productId: 'product-1', qty: 1, price: 12 })],
    })

    const saleItemOperation = lastTransactionOperations.find(op => op.type === 'set' && op.path.startsWith('saleItems/'))
    expect(saleItemOperation?.data).toMatchObject({ saleId: 'sale-42', productId: 'product-1', qty: 1, price: 12 })

    const stockOperation = lastTransactionOperations.find(op => op.type === 'set' && op.path.startsWith('stock/'))
    expect(stockOperation?.data).toMatchObject({ productId: 'product-1', qtyChange: -1, reason: 'sale', refId: 'sale-42' })

    const ledgerOperation = lastTransactionOperations.find(op => op.type === 'set' && op.path.startsWith('ledger/'))
    expect(ledgerOperation?.data).toMatchObject({ productId: 'product-1', qtyChange: -1, type: 'sale', refId: 'sale-42' })

    const productUpdate = lastTransactionOperations.find(op => op.type === 'update' && op.path === 'products/product-1')
    expect(productUpdate?.data).toMatchObject({ stockCount: 4 })

  })

  it('shows a friendly error when the transaction fails validation', async () => {
    firestoreState = {}
    const user = userEvent.setup()

    renderWithProviders(<Sell />)

    const productButton = await screen.findByRole('button', { name: /iced coffee/i })
    await user.click(productButton)

    const cashInput = screen.getByLabelText(/cash received/i)
    await user.clear(cashInput)
    await user.type(cashInput, '12')

    const recordButton = screen.getByRole('button', { name: /record sale/i })
    await user.click(recordButton)

    const errorAlert = await screen.findByText(/refresh your catalog and try again/i)
    expect(errorAlert).toBeInTheDocument()
    expect(runTransactionMock).toHaveBeenCalledTimes(1)
  })

  it('disables products that do not have a valid price', async () => {
    const user = userEvent.setup()

    renderWithProviders(<Sell />)

    const unavailableButton = await screen.findByRole('button', { name: /mystery item/i })
    expect(unavailableButton).toBeDisabled()
    expect(unavailableButton).toHaveTextContent(/price unavailable/i)
    expect(unavailableButton).toHaveTextContent(/set price to sell/i)

    await user.click(unavailableButton)

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })
})

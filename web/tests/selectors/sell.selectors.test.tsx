import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSellSelectors } from './sell'

const mockUseAuthUser = vi.fn(() => ({ uid: 'user-1', email: 'cashier@example.com' }))
const mockUseActiveStoreContext = vi.fn(() => ({
  storeId: 'store-1',
  isLoading: false,
  error: null,
  memberships: [],
  membershipsLoading: false,
  setActiveStoreId: vi.fn(),
  storeChangeToken: 0,
}))

const mockLoadCachedProducts = vi.fn(async () => [
  { id: 'product-1', name: 'Iced Coffee', price: 12, stockCount: 5 },
])
const mockSaveCachedProducts = vi.fn(async () => {})
const mockLoadCachedCustomers = vi.fn(async () => [])
const mockSaveCachedCustomers = vi.fn(async () => {})
const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }))
const orderByMock = vi.fn((field: string, direction?: string) => ({ field, direction }))
const limitMock = vi.fn((value: number) => ({ value }))
const queryMock = vi.fn((collectionRef: { path: string }, ...clauses: unknown[]) => ({
  collection: collectionRef,
  clauses,
}))
const onSnapshotMock = vi.fn(
  (
    queryRef: { collection: { path: string } },
    onNext: (snapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) => void,
  ) => {
    queueMicrotask(() => {
      if (queryRef.collection.path === 'products') {
        onNext({
          docs: [
            {
              id: 'product-1',
              data: () => ({ id: 'product-1', name: 'Iced Coffee', price: 12, stockCount: 5 }),
            },
          ],
        })
      } else if (queryRef.collection.path === 'customers') {
        onNext({ docs: [] })
      }
    })
    return () => {}
  },
)
const docMock = vi.fn(() => ({ type: 'doc' }))
const runTransactionMock = vi.fn(async () => undefined)
const serverTimestampMock = vi.fn(() => 'server-timestamp')

let Sell: typeof import('../../src/pages/Sell').default

describe('Sell page selectors', () => {
  beforeEach(async () => {
    vi.resetModules()

    mockUseAuthUser.mockClear()
    mockUseActiveStoreContext.mockClear()
    mockLoadCachedProducts.mockClear()
    mockSaveCachedProducts.mockClear()
    mockLoadCachedCustomers.mockClear()
    mockSaveCachedCustomers.mockClear()
    collectionMock.mockClear()
    queryMock.mockClear()
    whereMock.mockClear()
    orderByMock.mockClear()
    limitMock.mockClear()
    onSnapshotMock.mockClear()
    docMock.mockClear()
    runTransactionMock.mockClear()
    serverTimestampMock.mockClear()

    mockUseAuthUser.mockReturnValue({ uid: 'user-1', email: 'cashier@example.com' })
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-1',
      isLoading: false,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })

    mockLoadCachedProducts.mockResolvedValue([
      { id: 'product-1', name: 'Iced Coffee', price: 12, stockCount: 5 },
    ])
    mockLoadCachedCustomers.mockResolvedValue([])

    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: vi.fn(() => 'blob:mock-url'),
      })
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: vi.fn(),
      })
    }

    vi.doMock('../../src/hooks/useAuthUser', () => ({
      useAuthUser: () => mockUseAuthUser(),
    }))

    vi.doMock('../../src/context/ActiveStoreProvider', () => ({
      useActiveStoreContext: () => mockUseActiveStoreContext(),
    }))

    vi.doMock('../../src/utils/offlineCache', () => ({
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

    vi.doMock('../../src/utils/pdf', () => ({
      buildSimplePdf: vi.fn(() => new Uint8Array([0, 1, 2, 3])),
    }))

    vi.doMock('../../src/firebase', () => ({
      db: {},
    }))

    vi.doMock('firebase/firestore', () => ({
      collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
      query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
      where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
      orderBy: (...args: Parameters<typeof orderByMock>) => orderByMock(...args),
      limit: (...args: Parameters<typeof limitMock>) => limitMock(...args),
      onSnapshot: (...args: Parameters<typeof onSnapshotMock>) => onSnapshotMock(...args),
      doc: (...args: Parameters<typeof docMock>) => docMock(...args),
      runTransaction: (...args: Parameters<typeof runTransactionMock>) => runTransactionMock(...args),
      serverTimestamp: () => serverTimestampMock(),
    }))

    ;({ default: Sell } = await import('../../src/pages/Sell'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('locates core sell page controls', async () => {
    render(
      <MemoryRouter>
        <Sell />
      </MemoryRouter>
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())
    const catalogRegion = await screen.findByRole('region', { name: 'Product list' })
    const addButton = within(catalogRegion).getByRole('button', { name: /Iced Coffee/ })
    const user = userEvent.setup()
    await user.click(addButton)
    await screen.findByLabelText('Payment method')

    const selectors = createSellSelectors()

    expect(selectors.heading()).toHaveTextContent('Sell')
    expect(selectors.searchField()).toHaveAttribute('placeholder', 'Search by name')

    const catalog = selectors.productCatalogSection()
    expect(catalog).toBeInTheDocument()
    expect(within(catalog).getByText('Iced Coffee')).toBeInTheDocument()

    const cart = selectors.cartSection()
    expect(cart).toBeInTheDocument()
    expect(within(cart).getByRole('table')).toBeInTheDocument()
    expect(within(cart).getByText('Iced Coffee')).toBeInTheDocument()

    expect(selectors.paymentMethodSelect()).toHaveValue('cash')
    expect(selectors.cashReceivedInput()).toBeInTheDocument()

    const subtotal = selectors.subtotalDisplay()
    expect(within(subtotal).getByText('GHS 12.00')).toBeInTheDocument()

    expect(selectors.recordSaleButton()).not.toBeDisabled()
    expect(selectors.loyaltyNotice()).toBeNull()
  })
})

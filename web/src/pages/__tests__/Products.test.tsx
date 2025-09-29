import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import Products from '../Products'

const mockLoadCachedProducts = vi.fn(async () => [] as unknown[])
const mockSaveCachedProducts = vi.fn(async () => {})

vi.mock('../../utils/offlineCache', () => ({
  PRODUCT_CACHE_LIMIT: 200,
  loadCachedProducts: (...args: Parameters<typeof mockLoadCachedProducts>) =>
    mockLoadCachedProducts(...args),
  saveCachedProducts: (...args: Parameters<typeof mockSaveCachedProducts>) =>
    mockSaveCachedProducts(...args),
}))

vi.mock('../../firebase', () => ({
  db: {},
}))

const mockUseActiveStoreContext = vi.fn(() => ({ storeId: 'store-1', isLoading: false, error: null }))
vi.mock('../../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}))

const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const queryMock = vi.fn((collectionRef: { path: string }, ...clauses: unknown[]) => ({
  collection: collectionRef,
  clauses,
}))
const orderByMock = vi.fn((field: string, direction?: string) => ({ type: 'orderBy', field, direction }))
const limitMock = vi.fn((value: number) => ({ type: 'limit', value }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({
  type: 'where',
  field,
  op,
  value,
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
const addDocMock = vi.fn()
const updateDocMock = vi.fn(async () => {})
const serverTimestampMock = vi.fn(() => 'server-timestamp')
const docMock = vi.fn((collectionRef: { path: string }, id: string) => ({
  type: 'doc',
  path: `${collectionRef.path}/${id}`,
}))

vi.mock('firebase/firestore', () => ({
  collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
  orderBy: (...args: Parameters<typeof orderByMock>) => orderByMock(...args),
  limit: (...args: Parameters<typeof limitMock>) => limitMock(...args),
  onSnapshot: (
    ...args: Parameters<typeof onSnapshotMock>
  ) => onSnapshotMock(...args),
  addDoc: (...args: Parameters<typeof addDocMock>) => addDocMock(...args),
  updateDoc: (...args: Parameters<typeof updateDocMock>) => updateDocMock(...args),
  serverTimestamp: (...args: Parameters<typeof serverTimestampMock>) => serverTimestampMock(...args),
  doc: (...args: Parameters<typeof docMock>) => docMock(...args),
  where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
}))

describe('Products page', () => {
  beforeEach(() => {
    mockLoadCachedProducts.mockReset()
    mockSaveCachedProducts.mockReset()
    collectionMock.mockClear()
    queryMock.mockClear()
    orderByMock.mockClear()
    limitMock.mockClear()
    onSnapshotMock.mockClear()
    addDocMock.mockClear()
    updateDocMock.mockClear()
    serverTimestampMock.mockClear()
    docMock.mockClear()
    whereMock.mockClear()
    mockUseActiveStoreContext.mockReset()
    mockUseActiveStoreContext.mockReturnValue({ storeId: 'store-1', isLoading: false, error: null })



    mockLoadCachedProducts.mockResolvedValue([])
    mockSaveCachedProducts.mockResolvedValue(undefined)
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      queueMicrotask(() => {
        onNext({ docs: [] })
      })
      return () => {}
    })
  })



  it('shows an empty state when no products are available', async () => {
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(onSnapshotMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      snapshotHandler?.({ docs: [] })
    })

    await waitFor(() => {
      expect(screen.getByText(/no products found/i)).toBeInTheDocument()
    })
  })

  it('renders inventory details from the subscription', async () => {
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      snapshotHandler?.({
        docs: [
          {
            id: 'product-1',
            data: () => ({
              name: 'Iced Coffee',
              sku: 'COF-01',
              price: 12,
              stockCount: 2,
              reorderThreshold: 5,
              lastReceipt: { qty: 12, supplier: 'ACME' },
            }),
          },
        ],
      })
    })

    const productRow = await screen.findByTestId('product-row-product-1')
    expect(productRow).toHaveTextContent('Iced Coffee')
    expect(within(productRow).getByText(/low stock/i)).toBeInTheDocument()
    expect(within(productRow).getByText(/GHS 12\.00/)).toBeInTheDocument()
    expect(mockSaveCachedProducts).toHaveBeenCalled()
  })

  it('shows a placeholder when a product is missing a price', async () => {
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      snapshotHandler?.({
        docs: [
          {
            id: 'product-3',
            data: () => ({
              name: 'Unpriced Item',
              sku: 'UNP-01',
            }),
          },
        ],
      })
    })

    const productRow = await screen.findByTestId('product-row-product-3')
    const cells = within(productRow).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('—')
  })

  it('requires a valid price when creating a product', async () => {
    const user = userEvent.setup()
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      snapshotHandler?.({ docs: [] })
    })

    await user.type(screen.getByLabelText('Name'), 'Incomplete Product')
    await user.type(screen.getByLabelText('SKU'), 'INC-01')
    await user.type(screen.getByLabelText('Price'), '-5')

    await user.click(screen.getByRole('button', { name: /add product/i }))

    expect(addDocMock).not.toHaveBeenCalled()
    expect(
      await screen.findByText(/enter a valid price that is zero or greater/i),
    ).toBeInTheDocument()
  })

  it('optimistically renders a newly created product', async () => {
    const user = userEvent.setup()
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    let resolveAddDoc: ((value: { id: string }) => void) | null = null
    addDocMock.mockImplementation(async (...args: unknown[]) => {
      return new Promise<{ id: string }>(resolve => {
        resolveAddDoc = resolve
      })
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      snapshotHandler?.({ docs: [] })
    })

    await user.type(screen.getByLabelText('Name'), 'New Blend')
    await user.type(screen.getByLabelText('SKU'), 'NB-01')
    await user.type(screen.getByLabelText('Price'), '18')
    await user.type(screen.getByLabelText('Reorder point'), '4')
    await user.type(screen.getByLabelText('Opening stock'), '10')

    await user.click(screen.getByRole('button', { name: /add product/i }))

    expect(addDocMock).toHaveBeenCalled()
    expect(addDocMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'products' }),
      expect.objectContaining({
        name: 'New Blend',
        sku: 'NB-01',
        price: 18,
        reorderThreshold: 4,
        stockCount: 10,
      }),
    )
    expect(screen.getByText('Syncing…')).toBeInTheDocument()

    await act(async () => {
      resolveAddDoc?.({ id: 'product-2' })
    })

    await waitFor(() => {
      expect(screen.getByText('Product created successfully.')).toBeInTheDocument()
    })

    await act(async () => {
      snapshotHandler?.({
        docs: [
          {
            id: 'product-2',
            data: () => ({
              name: 'New Blend',
              sku: 'NB-01',
              price: 18,
              stockCount: 10,
              reorderThreshold: 4,
            }),
          },
        ],
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('Syncing…')).not.toBeInTheDocument()
      expect(screen.getByText('New Blend')).toBeInTheDocument()
    })
  })

  it('keeps a newly saved product visible when the cache resolves without it', async () => {
    const user = userEvent.setup()
    let resolveCache: ((value: unknown[]) => void) | null = null
    mockLoadCachedProducts.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCache = resolve
        }),
    )

    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    let resolveAddDoc: ((value: { id: string }) => void) | null = null
    addDocMock.mockImplementation(async () => {
      return new Promise<{ id: string }>(resolve => {
        resolveAddDoc = resolve
      })
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      snapshotHandler?.({ docs: [] })
    })

    await user.type(screen.getByLabelText('Name'), 'Cache Blend')
    await user.type(screen.getByLabelText('SKU'), 'CB-01')
    await user.type(screen.getByLabelText('Price'), '15')

    await user.click(screen.getByRole('button', { name: /add product/i }))

    await act(async () => {
      resolveAddDoc?.({ id: 'product-cache' })
    })

    expect(await screen.findByText('Cache Blend')).toBeInTheDocument()

    await act(async () => {
      resolveCache?.([])
      await Promise.resolve()
    })

    expect(screen.getByText('Cache Blend')).toBeInTheDocument()
  })

  it('saves price updates when editing a product', async () => {
    const user = userEvent.setup()
    let snapshotHandler: ((snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => void) | null = null
    onSnapshotMock.mockImplementation((queryRef, onNext) => {
      snapshotHandler = onNext
      return () => {}
    })

    render(
      <MemoryRouter>
        <Products />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      snapshotHandler?.({
        docs: [
          {
            id: 'product-9',
            data: () => ({
              name: 'Legacy Item',
              sku: 'LEG-01',
              price: 10,
              stockCount: 5,
            }),
          },
        ],
      })
    })

    const editButton = await screen.findByRole('button', { name: /edit/i })
    await user.click(editButton)

    const dialog = await screen.findByRole('dialog')
    const priceInput = within(dialog).getByLabelText('Price')
    await user.clear(priceInput)
    await user.type(priceInput, '20')

    const saveButton = within(dialog).getByRole('button', { name: /save changes/i })
    await user.click(saveButton)

    await waitFor(() => expect(updateDocMock).toHaveBeenCalledTimes(1))

    expect(updateDocMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'products/product-9' }),
      expect.objectContaining({ price: 20 }),
    )
  })
})


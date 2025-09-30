import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createReceiveSelectors } from './receive'

const mockUseActiveStoreContext = vi.fn(() => ({
  storeId: 'store-1',
  storeChangeToken: 0,
}))

const mockPublish = vi.fn()

const mockLoadCachedProducts = vi.fn(async () => [
  { id: 'prod-1', name: 'Widget', stockCount: 10 },
])
const mockSaveCachedProducts = vi.fn(async () => {})

const queueCallableRequestMock = vi.fn(async () => true)
const receiveStockMock = vi.fn(async () => undefined)
const httpsCallableMock = vi.fn(() => receiveStockMock)
const collectionMock = vi.fn((_db: unknown, path: string) => ({ type: 'collection', path }))
const queryMock = vi.fn((collectionRef: { path: string }, ...clauses: unknown[]) => ({
  collection: collectionRef,
  clauses,
}))
const orderByMock = vi.fn((field: string, direction?: string) => ({ field, direction }))
const limitMock = vi.fn((value: number) => ({ value }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }))
const onSnapshotMock = vi.fn(
  (
    queryRef: { collection: { path: string } },
    onNext: (snapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) => void,
  ) => {
    queueMicrotask(() => {
      onNext({
        docs: [
          {
            id: 'prod-1',
            data: () => ({ id: 'prod-1', name: 'Widget', stockCount: 10 }),
          },
        ],
      })
    })
    return () => {}
  },
)

let Receive: typeof import('../../src/pages/Receive').default

describe('Receive page selectors', () => {
  beforeEach(async () => {
    vi.resetModules()

    mockUseActiveStoreContext.mockClear()
    mockUseActiveStoreContext.mockReturnValue({ storeId: 'store-1', storeChangeToken: 0 })
    mockPublish.mockClear()
    mockLoadCachedProducts.mockClear()
    mockLoadCachedProducts.mockResolvedValue([{ id: 'prod-1', name: 'Widget', stockCount: 10 }])
    mockSaveCachedProducts.mockClear()
    queueCallableRequestMock.mockClear()
    receiveStockMock.mockClear()
    httpsCallableMock.mockClear()
    httpsCallableMock.mockReturnValue(receiveStockMock)
    collectionMock.mockClear()
    queryMock.mockClear()
    orderByMock.mockClear()
    limitMock.mockClear()
    whereMock.mockClear()
    onSnapshotMock.mockClear()

    vi.doMock('../../src/context/ActiveStoreProvider', () => ({
      useActiveStoreContext: () => mockUseActiveStoreContext(),
    }))

    vi.doMock('../../src/components/ToastProvider', () => ({
      useToast: () => ({ publish: mockPublish }),
    }))

    vi.doMock('../../src/firebase', () => ({
      db: {},
      functions: {},
    }))

    vi.doMock('../../src/utils/offlineCache', () => ({
      PRODUCT_CACHE_LIMIT: 200,
      loadCachedProducts: (...args: Parameters<typeof mockLoadCachedProducts>) =>
        mockLoadCachedProducts(...args),
      saveCachedProducts: (...args: Parameters<typeof mockSaveCachedProducts>) =>
        mockSaveCachedProducts(...args),
    }))

    vi.doMock('../../src/utils/offlineQueue', () => ({
      queueCallableRequest: (...args: Parameters<typeof queueCallableRequestMock>) =>
        queueCallableRequestMock(...args),
    }))

    vi.doMock('firebase/functions', () => ({
      httpsCallable: (...args: Parameters<typeof httpsCallableMock>) => httpsCallableMock(...args),
    }))

    vi.doMock('firebase/firestore', () => ({
      collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
      query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
      orderBy: (...args: Parameters<typeof orderByMock>) => orderByMock(...args),
      limit: (...args: Parameters<typeof limitMock>) => limitMock(...args),
      where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
      onSnapshot: (...args: Parameters<typeof onSnapshotMock>) => onSnapshotMock(...args),
    }))

    ;({ default: Receive } = await import('../../src/pages/Receive'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('provides handles for the receive form fields', async () => {
    render(
      <MemoryRouter>
        <Receive />
      </MemoryRouter>
    )

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled())
    await screen.findByRole('option', { name: 'Widget (Stock 10)' })

    const selectors = createReceiveSelectors()

    expect(selectors.heading()).toHaveTextContent('Receive stock')
    expect(selectors.productSelect()).toHaveValue('')
    expect(selectors.quantityInput()).toHaveAttribute('type', 'number')
    expect(selectors.supplierInput()).toHaveAttribute('placeholder', 'Acme Distribution')
    expect(selectors.referenceInput()).toHaveAttribute('placeholder', 'PO-12345 or packing slip')
    expect(selectors.unitCostInput()).toHaveAttribute('step', '0.01')

    const options = within(selectors.productSelect()).getAllByRole('option')
    expect(options).toHaveLength(2)

    expect(selectors.addStockButton()).toBeDisabled()
    expect(selectors.statusMessage()).toBeNull()
  })
})

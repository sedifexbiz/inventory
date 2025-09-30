import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTodaySelectors } from './today'

const mockUseActiveStoreContext = vi.fn(() => ({
  storeId: 'store-1',
  isLoading: false,
  storeChangeToken: 0,
  error: null,
  memberships: [],
  membershipsLoading: false,
  setActiveStoreId: vi.fn(),
}))

const collectionMock = vi.fn((db: unknown, path: string) => ({ type: 'collection', db, path }))
const docMock = vi.fn((db: unknown, path: string, id: string) => ({ type: 'doc', db, path, id }))
const getDocMock = vi.fn()
const getDocsMock = vi.fn()
const limitMock = vi.fn((count: number) => ({ type: 'limit', count }))
const orderByMock = vi.fn((field: string, direction: string) => ({ type: 'orderBy', field, direction }))
const queryMock = vi.fn((ref: unknown, ...constraints: unknown[]) => ({
  type: 'query',
  ref,
  constraints,
}))
const startAfterMock = vi.fn((...args: unknown[]) => ({ type: 'startAfter', args }))
const whereMock = vi.fn((field: string, op: string, value: unknown) => ({
  type: 'where',
  field,
  op,
  value,
}))

let Today: typeof import('../../src/pages/Today').default

describe('Today page selectors', () => {
  beforeEach(async () => {
    vi.resetModules()

    mockUseActiveStoreContext.mockReset()
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-1',
      isLoading: false,
      storeChangeToken: 0,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
    })

    getDocMock.mockReset()
    getDocsMock.mockReset()

    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          message: 'Sold Cold Brew',
          salesTotal: 480.5,
          salesCount: 8,
          cardTotal: 320,
          cashTotal: 160.5,
          receiptCount: 6,
          receiptUnits: 18,
          newCustomers: 2,
          topProducts: [
            { id: 'prod-2', name: 'Cold Brew', unitsSold: 18, salesTotal: 220 },
            { id: 'prod-3', name: 'Croissant', unitsSold: 25, salesTotal: 125 },
          ],
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          salesTotal: 460,
          salesCount: 10,
        }),
      })

    getDocsMock.mockResolvedValue({
      docs: [
        {
          id: 'activity-1',
          data: () => ({
            message: 'Sold Cold Brew',
            type: 'sale',
            title: 'Sold Cold Brew',
            description: '2 units sold to walk-in customer',
            at: { toDate: () => new Date('2023-05-01T10:15:00Z') },
          }),
        },
      ],
    })

    vi.doMock('../../src/context/ActiveStoreProvider', () => ({
      useActiveStoreContext: () => mockUseActiveStoreContext(),
    }))

    vi.doMock('../../src/firebase', () => ({
      db: {},
    }))

    vi.doMock('firebase/firestore', () => ({
      collection: (...args: Parameters<typeof collectionMock>) => collectionMock(...args),
      doc: (...args: Parameters<typeof docMock>) => docMock(...args),
      getDoc: (...args: Parameters<typeof getDocMock>) => getDocMock(...args),
      getDocs: (...args: Parameters<typeof getDocsMock>) => getDocsMock(...args),
      limit: (...args: Parameters<typeof limitMock>) => limitMock(...args),
      orderBy: (...args: Parameters<typeof orderByMock>) => orderByMock(...args),
      query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
      startAfter: (...args: Parameters<typeof startAfterMock>) => startAfterMock(...args),
      where: (...args: Parameters<typeof whereMock>) => whereMock(...args),
    }))

    ;({ default: Today } = await import('../../src/pages/Today'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('surfaces navigation, summary, and activity handles', async () => {
    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>
    )

    await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(getDocsMock).toHaveBeenCalledTimes(1))

    const selectors = createTodaySelectors()

    expect(selectors.heading()).toHaveTextContent('Today')

    const quickNav = selectors.quickActionsNav()
    expect(quickNav).toBeInTheDocument()
    expect(selectors.quickActionLink('Receive Stock')).toHaveAttribute('href', '/receive')

    const kpiSection = selectors.kpiSection()
    expect(kpiSection).toBeInTheDocument()
    await waitFor(() => expect(selectors.kpiCards().length).toBeGreaterThan(0))

    const activitySection = selectors.activitySection()
    expect(activitySection).toBeInTheDocument()
    expect(selectors.activityFilterGroup()).toBeInTheDocument()
    expect(selectors.activityFilterButton('All')).toHaveAttribute('type', 'button')

    await waitFor(() => expect(selectors.activityItems().length).toBeGreaterThan(0))
    const activityItems = selectors.activityItems()
    expect(activityItems[0]).toHaveTextContent('Sold Cold Brew')
    expect(activityItems[0]).toHaveTextContent(/sale/i)
  })
})

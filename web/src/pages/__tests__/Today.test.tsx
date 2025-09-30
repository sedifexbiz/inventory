import React from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'


import { formatCurrency } from '@shared/currency'
import Today, { formatDateKey } from '../Today'


const currencyText = (value: number) => formatCurrency(value)
const signedCurrency = (value: number) => `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`

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

vi.mock('../../firebase', () => ({
  db: {},
}))

const collectionMock = vi.fn((db: unknown, path: string) => ({ type: 'collection', db, path }))
const docMock = vi.fn((db: unknown, path: string, id: string) => ({ type: 'doc', db, path, id }))
const getDocMock = vi.fn()
const getDocsMock = vi.fn()
const limitMock = vi.fn((count: number) => ({ type: 'limit', count }))
const orderByMock = vi.fn((field: string, direction: string) => ({
  type: 'orderBy',
  field,
  direction,
}))
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

vi.mock('firebase/firestore', () => ({
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

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Today page', () => {
  function mockEmptyFirestoreResponses() {
    getDocMock
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => ({}),
      })
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => ({}),
      })

    getDocsMock.mockResolvedValue({ docs: [] })
  }

  beforeEach(() => {
    mockUseActiveStoreContext.mockReset()
    mockUseActiveStoreContext.mockReturnValue({
      storeId: 'store-123',
      isLoading: false,
      error: null,
      memberships: [],
      membershipsLoading: false,
      setActiveStoreId: vi.fn(),
      storeChangeToken: 0,
    })

    collectionMock.mockClear()
    docMock.mockClear()
    getDocMock.mockReset()
    getDocsMock.mockReset()
    limitMock.mockClear()
    orderByMock.mockClear()
    queryMock.mockClear()
    startAfterMock.mockClear()
    whereMock.mockClear()
  })

  it("shows loading indicators while Firestore requests are pending", async () => {
    const summaryDeferred = createDeferred<{
      exists: () => boolean
      data: () => Record<string, unknown>
    }>()
    const previousSummaryDeferred = createDeferred<{
      exists: () => boolean
      data: () => Record<string, unknown>
    }>()
    const activitiesDeferred = createDeferred<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>()

    getDocMock
      .mockReturnValueOnce(summaryDeferred.promise)
      .mockReturnValueOnce(previousSummaryDeferred.promise)
    getDocsMock.mockReturnValue(activitiesDeferred.promise)

    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    )

    expect(screen.getAllByText(/Loading today's summary/i)[0]).toBeInTheDocument()
    expect(screen.getAllByText(/Loading activity feed/i)[0]).toBeInTheDocument()

    summaryDeferred.resolve({
      exists: () => true,
      data: () => ({
        salesTotal: 420,
        salesCount: 12,
        cardTotal: 280,
        cashTotal: 140,
        receiptCount: 9,
        receiptUnits: 18,
        newCustomers: 3,
        topProducts: [],
      }),
    })
    previousSummaryDeferred.resolve({
      exists: () => false,
      data: () => ({}),
    })
    activitiesDeferred.resolve({ docs: [] })

    await waitFor(() => {
      expect(getDocMock).toHaveBeenCalledTimes(2)
      expect(getDocsMock).toHaveBeenCalledTimes(1)
    })
  })

  it('renders KPI cards and activities when data is available', async () => {
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
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
            { id: 'prod-1', name: 'Espresso', unitsSold: 12, salesTotal: 180 },
            { id: 'prod-4', name: 'Muffin', unitsSold: 15, salesTotal: 90 },
            { id: 'prod-5', name: 'Tea', unitsSold: 10, salesTotal: 40 },
            { id: 'prod-6', name: 'Bagel', unitsSold: 6, salesTotal: 30 },
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
            message: 'Sold 3 iced coffees',
            type: 'sale',
            actor: { displayName: 'Lila' },
            at: { toDate: () => new Date('2024-02-20T08:05:00Z') },
          }),
        },
        {
          id: 'activity-2',
          data: () => ({
            message: 'Added a new customer',
            type: 'customer',
            actor: 'Marcus',
            at: { toDate: () => new Date('2024-02-20T07:45:00Z') },
          }),
        },
      ],
    })

    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    )

    const expectedKey = formatDailySummaryKey(new Date())
    const previousDate = new Date()
    previousDate.setDate(previousDate.getDate() - 1)
    const expectedPreviousKey = formatDailySummaryKey(previousDate)

    await waitFor(() => {
      expect(screen.getByText(currencyText(480.5))).toBeInTheDocument()
    })

    expect(screen.getByText('8 sales')).toBeInTheDocument()
    expect(screen.getByText('Sales variance')).toBeInTheDocument()
    expect(screen.getByText(signedCurrency(20.5))).toBeInTheDocument()
    expect(screen.getByText(`+4.5% vs ${currencyText(460)} yesterday`)).toBeInTheDocument()
    expect(screen.getByText('Average basket size')).toBeInTheDocument()
    expect(screen.getByText(currencyText(60.06))).toBeInTheDocument()
    expect(screen.getByText('Across 8 sales')).toBeInTheDocument()
    expect(screen.getByText('Card payments')).toBeInTheDocument()
    expect(screen.getByText('Cash payments')).toBeInTheDocument()
    expect(screen.getByText('New customers')).toBeInTheDocument()
    expect(screen.getByText('Top products')).toBeInTheDocument()
    expect(screen.getByText('Cold Brew')).toBeInTheDocument()
    expect(screen.getByText(`${currencyText(220)} · 18 units sold`)).toBeInTheDocument()

    expect(screen.getByText('Sold 3 iced coffees')).toBeInTheDocument()
    expect(screen.getByText(/sale • Lila •/i)).toBeInTheDocument()
    expect(screen.getByText('Added a new customer')).toBeInTheDocument()
    expect(screen.getByText(/customer • Marcus •/i)).toBeInTheDocument()

    const docCalls = docMock.mock.calls as unknown[][]
    const dailySummaryCalls = docCalls.filter(([, collection]) => collection === 'dailySummaries')
    expect(dailySummaryCalls).toHaveLength(2)
    const requestedIds = dailySummaryCalls.map(([, , id]) => id)
    expect(requestedIds).toContain(`store-123_${expectedKey}`)
    expect(requestedIds).toContain(`store-123_${expectedPreviousKey}`)
    expect(whereMock).toHaveBeenCalledWith('storeId', '==', 'store-123')
    expect(whereMock).toHaveBeenCalledWith('dateKey', '==', expectedKey)
    expect(orderByMock).toHaveBeenCalledWith('at', 'desc')
    expect(limitMock).toHaveBeenCalledWith(50)
  })

  it('handles zero sales gracefully', async () => {
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          salesTotal: 0,
          salesCount: 0,
          cardTotal: 0,
          cashTotal: 0,
          receiptCount: 0,
          receiptUnits: 0,
          newCustomers: 0,
          topProducts: [],
        }),
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          salesTotal: 0,
          salesCount: 0,
        }),
      })

    getDocsMock.mockResolvedValue({ docs: [] })

    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText('Sales variance')).toBeInTheDocument()
    })

    expect(screen.getByText(signedCurrency(0))).toBeInTheDocument()
    expect(screen.getByText('No sales recorded today or yesterday')).toBeInTheDocument()
    expect(screen.getByText('Average basket size')).toBeInTheDocument()
    expect(screen.getAllByText(currencyText(0)).length).toBeGreaterThan(0)
    expect(screen.getByText('No sales recorded today')).toBeInTheDocument()
    expect(screen.getByText('No product sales recorded today.')).toBeInTheDocument()
  })


  it('filters activities by type when a filter is selected', async () => {
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          salesTotal: 100,
          salesCount: 2,
          cardTotal: 60,
          cashTotal: 40,
          receiptCount: 2,
          receiptUnits: 4,
          newCustomers: 1,
          topProducts: [],
        }),
      })
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => ({}),
      })

    getDocsMock
      .mockResolvedValueOnce({
        docs: [
          {
            id: 'activity-1',
            data: () => ({
              message: 'Initial activity',
              type: 'sale',
              actor: 'Lila',
              at: { toDate: () => new Date('2024-02-20T08:05:00Z') },
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        docs: [
          {
            id: 'activity-2',
            data: () => ({
              message: 'Filtered sale',
              type: 'sale',
              actor: 'Marcus',
              at: { toDate: () => new Date('2024-02-20T09:15:00Z') },
            }),
          },
        ],
      })


    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    )


    await waitFor(() => {
      expect(screen.getByText('Initial activity')).toBeInTheDocument()
    })

    const salesFilter = screen.getByRole('button', { name: 'Sales' })
    fireEvent.click(salesFilter)

    await waitFor(() => {
      expect(screen.getByText('Filtered sale')).toBeInTheDocument()
    })

    expect(whereMock).toHaveBeenCalledWith('type', '==', 'sale')
    expect(getDocsMock).toHaveBeenCalledTimes(2)
  })

  it('loads additional activity pages using startAfter', async () => {
    getDocMock
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          salesTotal: 100,
          salesCount: 2,
          cardTotal: 60,
          cashTotal: 40,
          receiptCount: 2,
          receiptUnits: 4,
          newCustomers: 1,
          topProducts: [],
        }),
      })
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => ({}),
      })

    const firstPageDocs = Array.from({ length: 50 }, (_, index) => ({
      id: `activity-${index}`,
      data: () => ({
        message: `Activity ${index}`,
        type: 'sale',
        actor: 'User',
        at: { toDate: () => new Date(`2024-02-20T08:${String(index).padStart(2, '0')}:00Z`) },
      }),
    }))

    const lastDoc = firstPageDocs[firstPageDocs.length - 1]

    const secondPageDocs = [
      {
        id: 'activity-next',
        data: () => ({
          message: 'Next page activity',
          type: 'sale',
          actor: 'User',
          at: { toDate: () => new Date('2024-02-20T09:45:00Z') },
        }),
      },
    ]

    getDocsMock
      .mockResolvedValueOnce({ docs: firstPageDocs })
      .mockResolvedValueOnce({ docs: secondPageDocs })

    render(
      <MemoryRouter>
        <Today />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText('Activity 0')).toBeInTheDocument()
    })

    const loadMoreButton = screen.getByRole('button', { name: 'Load more' })
    expect(loadMoreButton).toBeEnabled()

    fireEvent.click(loadMoreButton)
    fireEvent.click(loadMoreButton)

    await waitFor(() => {
      expect(screen.getByText('Next page activity')).toBeInTheDocument()
    })

    expect(getDocsMock).toHaveBeenCalledTimes(2)
    expect(startAfterMock).toHaveBeenCalledWith(lastDoc)
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()

  })
})

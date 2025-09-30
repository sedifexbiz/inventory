
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { Link } from 'react-router-dom'
import { formatDailySummaryKey } from '../../../shared/dateKeys'
import { db } from '../firebase'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import { formatCurrency } from '@shared/currency'

type TopProduct = {
  id: string
  name: string
  unitsSold: number
  salesTotal: number
}

type DailySummary = {
  salesTotal: number
  salesCount: number
  cardTotal: number
  cashTotal: number
  receiptCount: number
  receiptUnits: number
  newCustomers: number
  previousSalesTotal: number | null
  previousSalesCount: number | null
  topProducts: TopProduct[]
}

type MetricCard = {
  type: 'metric'
  title: string
  primary: string
  secondary: string
}

type ProductsCard = {
  type: 'products'
  title: string
  products: TopProduct[]
}

type ActivityEntry = {
  id: string
  message: string
  type: string | null
  actor: string | null
  at: Date | null
}

type ActivityFilter = 'all' | 'sale' | 'receipt' | 'customer'

const ACTIVITY_PAGE_SIZE = 50

type TimestampLike = { toDate?: () => Date }

function isTimestamp(value: unknown): value is TimestampLike {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as TimestampLike).toDate === 'function',
  )
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const parsed = Number.parseFloat(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function toInteger(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function mapTopProducts(value: unknown): TopProduct[] {
  if (!Array.isArray(value)) return []

  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const record = entry as Record<string, unknown>
      const rawId =
        typeof record.id === 'string' && record.id.trim()
          ? record.id.trim()
          : typeof record.productId === 'string' && record.productId.trim()
            ? record.productId.trim()
            : null

      const rawName =
        typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : null

      const unitsSold = toInteger(
        record.unitsSold ?? record.quantity ?? record.qty ?? record.units ?? record.count,
      )

      const salesTotal = toNumber(
        record.salesTotal ?? record.total ?? record.revenue ?? record.amount ?? record.value,
      )

      return {
        id: rawId ?? `product-${index}`,
        name: rawName ?? rawId ?? `Product ${index + 1}`,
        unitsSold,
        salesTotal,
      }
    })
    .filter((product): product is TopProduct => Boolean(product))
}

function mapDailySummary(data: DocumentData | undefined): DailySummary {
  return {
    salesTotal: toNumber(data?.salesTotal),
    salesCount: toInteger(data?.salesCount),
    cardTotal: toNumber(data?.cardTotal),
    cashTotal: toNumber(data?.cashTotal),
    receiptCount: toInteger(data?.receiptCount),
    receiptUnits: toInteger(data?.receiptUnits),
    newCustomers: toInteger(data?.newCustomers),
    previousSalesTotal:
      data && Object.prototype.hasOwnProperty.call(data, 'previousSalesTotal')
        ? toNumber((data as Record<string, unknown>).previousSalesTotal)
        : null,
    previousSalesCount:
      data && Object.prototype.hasOwnProperty.call(data, 'previousSalesCount')
        ? toInteger((data as Record<string, unknown>).previousSalesCount)
        : null,
    topProducts: mapTopProducts(data && (data as Record<string, unknown>).topProducts),
  }
}

function mapActivity(docSnapshot: QueryDocumentSnapshot<DocumentData>): ActivityEntry {
  const data = docSnapshot.data()

  const message =
    typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : 'Activity recorded'

  const type = typeof data.type === 'string' && data.type.trim() ? data.type.trim() : null

  let actor: string | null = null
  const rawActor = data.actor
  if (typeof rawActor === 'string' && rawActor.trim()) {
    actor = rawActor.trim()
  } else if (rawActor && typeof rawActor === 'object') {
    const displayName =
      typeof (rawActor as Record<string, unknown>).displayName === 'string'
        ? (rawActor as Record<string, unknown>).displayName
        : null
    const email =
      typeof (rawActor as Record<string, unknown>).email === 'string'
        ? (rawActor as Record<string, unknown>).email
        : null
    actor = (displayName || email || '').trim() || null
  }

  let at: Date | null = null
  const rawTimestamp = data.at
  if (isTimestamp(rawTimestamp)) {
    try {
      at = rawTimestamp.toDate() ?? null
    } catch (error) {
      console.error('[today] unable to convert timestamp', error)
      at = null
    }
  } else if (typeof rawTimestamp === 'string') {
    const parsed = new Date(rawTimestamp)
    at = Number.isNaN(parsed.getTime()) ? null : parsed
  }

  return {
    id: docSnapshot.id,
    message,
    type,
    actor,
    at,
  }
}

function formatNumber(value: number) {
  return value.toLocaleString()
}

function formatSignedCurrency(value: number) {
  const formatted = formatCurrency(Math.abs(value))
  const sign = value >= 0 ? '+' : '-'
  return `${sign}${formatted}`
}

function formatSignedPercentage(value: number) {
  const sign = value >= 0 ? '+' : '-'
  return `${sign}${Math.abs(value).toFixed(1)}%`
}

function formatTime(value: Date | null) {
  if (!value) return '—'
  try {
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch (error) {
    console.error('[today] unable to format time', error)
    return '—'
  }
}

export default function Today() {
  const { storeId, isLoading: storeLoading, storeChangeToken } = useActiveStoreContext()

  const quickActions = useMemo(
    () => [
      {
        label: 'New Product',
        to: '/products',
        ariaLabel: 'Create a new product in your catalog',
      },
      {
        label: 'Receive Stock',
        to: '/receive',
        ariaLabel: 'Record received stock items',
      },
      {
        label: 'Start Sale',
        to: '/sell',
        ariaLabel: 'Start a new point of sale session',
      },
    ],
    [],
  )

  const today = useMemo(() => new Date(), [])
  const todayKey = useMemo(() => formatDailySummaryKey(today), [today])
  const previousDayKey = useMemo(() => {
    const previous = new Date(today)
    previous.setDate(previous.getDate() - 1)
    return formatDailySummaryKey(previous)
  }, [today])
  const todayLabel = useMemo(
    () =>
      today.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    [today],
  )

  const [summary, setSummary] = useState<DailySummary | null>(null)
  const [previousSummary, setPreviousSummary] = useState<DailySummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(false)
  const [activitiesError, setActivitiesError] = useState<string | null>(null)
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [lastActivityDoc, setLastActivityDoc] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null)
  const [hasMoreActivities, setHasMoreActivities] = useState(false)
  const [isLoadingMoreActivities, setIsLoadingMoreActivities] = useState(false)
  const isLoadingMoreRef = useRef(false)

  useEffect(() => {
    if (!storeId) {
      setSummary(null)
      setPreviousSummary(null)
      setSummaryLoading(false)
      setSummaryError(null)
      return
    }

    let cancelled = false
    setSummaryLoading(true)
    setSummaryError(null)

    const todayRef = doc(db, 'dailySummaries', `${storeId}_${todayKey}`)
    const previousRef = doc(db, 'dailySummaries', `${storeId}_${previousDayKey}`)

    Promise.all([getDoc(todayRef), getDoc(previousRef)])
      .then(([todaySnapshot, previousSnapshot]) => {
        if (cancelled) return

        if (todaySnapshot.exists()) {
          setSummary(mapDailySummary(todaySnapshot.data()))
        } else {
          setSummary(mapDailySummary(undefined))
        }

        if (previousSnapshot.exists()) {
          setPreviousSummary(mapDailySummary(previousSnapshot.data()))
        } else {
          setPreviousSummary(null)
        }
      })
      .catch(error => {
        if (cancelled) return
        console.error('[today] failed to load daily summary', error)
        setSummary(null)
        setPreviousSummary(null)
        setSummaryError("We couldn't load today's summary.")
      })
      .finally(() => {
        if (cancelled) return
        setSummaryLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [storeId, todayKey, previousDayKey, storeChangeToken])

  useEffect(() => {
    if (!storeId) {
      setActivities([])
      setActivitiesLoading(false)
      setActivitiesError(null)
      setLastActivityDoc(null)
      setHasMoreActivities(false)
      setIsLoadingMoreActivities(false)
      isLoadingMoreRef.current = false
      return
    }

    let cancelled = false
    setActivitiesLoading(true)
    setActivitiesError(null)
    setIsLoadingMoreActivities(false)
    isLoadingMoreRef.current = false
    setActivities([])
    setLastActivityDoc(null)
    setHasMoreActivities(false)

    const activityCollection = collection(db, 'activities')
    const constraints = [
      where('storeId', '==', storeId),
      where('dateKey', '==', todayKey),
      orderBy('at', 'desc'),
    ]
    if (activityFilter !== 'all') {
      constraints.splice(2, 0, where('type', '==', activityFilter))
    }
    constraints.push(limit(ACTIVITY_PAGE_SIZE))

    const activitiesQuery = query(activityCollection, ...constraints)

    getDocs(activitiesQuery)
      .then(snapshot => {
        if (cancelled) return
        setActivities(snapshot.docs.map(mapActivity))
        setLastActivityDoc(
          snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : null,
        )
        setHasMoreActivities(snapshot.docs.length === ACTIVITY_PAGE_SIZE)
      })
      .catch(error => {
        if (cancelled) return
        console.error('[today] failed to load activities', error)
        setActivities([])
        setActivitiesError("We couldn't load the activity feed.")
      })
      .finally(() => {
        if (cancelled) return
        setActivitiesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [storeId, todayKey, activityFilter, storeChangeToken])

  useEffect(() => {
    setSummary(null)
    setPreviousSummary(null)
    setSummaryError(null)
    setActivities([])
    setActivitiesError(null)
    setLastActivityDoc(null)
    setHasMoreActivities(false)
    setIsLoadingMoreActivities(false)
    isLoadingMoreRef.current = false
  }, [storeChangeToken])

  const loadMoreActivities = () => {
    if (
      !storeId ||
      !hasMoreActivities ||
      !lastActivityDoc ||
      activitiesLoading ||
      isLoadingMoreActivities ||
      isLoadingMoreRef.current
    ) {
      return
    }

    isLoadingMoreRef.current = true
    setIsLoadingMoreActivities(true)
    setActivitiesError(null)

    const activityCollection = collection(db, 'activities')
    const constraints = [
      where('storeId', '==', storeId),
      where('dateKey', '==', todayKey),
    ]
    if (activityFilter !== 'all') {
      constraints.push(where('type', '==', activityFilter))
    }
    constraints.push(orderBy('at', 'desc'), startAfter(lastActivityDoc), limit(ACTIVITY_PAGE_SIZE))

    const activitiesQuery = query(activityCollection, ...constraints)

    getDocs(activitiesQuery)
      .then(snapshot => {
        setActivities(previous => [...previous, ...snapshot.docs.map(mapActivity)])
        setLastActivityDoc(
          snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : lastActivityDoc,
        )
        setHasMoreActivities(snapshot.docs.length === ACTIVITY_PAGE_SIZE)
      })
      .catch(error => {
        console.error('[today] failed to load more activities', error)
        setActivitiesError("We couldn't load the activity feed.")
      })
      .finally(() => {
        isLoadingMoreRef.current = false
        setIsLoadingMoreActivities(false)
      })
  }

  const activityFilters: Array<{ label: string; value: ActivityFilter }> = useMemo(
    () => [
      { label: 'All', value: 'all' },
      { label: 'Sales', value: 'sale' },
      { label: 'Receipts', value: 'receipt' },
      { label: 'Customers', value: 'customer' },
    ],
    [],
  )

  const sortedTopProducts = useMemo(() => {
    if (!summary) return []

    return [...summary.topProducts]
      .sort((a, b) => {
        if (b.salesTotal !== a.salesTotal) {
          return b.salesTotal - a.salesTotal
        }

        return b.unitsSold - a.unitsSold
      })
      .slice(0, 5)
  }, [summary])

  if (storeLoading) {
    return (
      <div>
        <h2 style={{ color: '#4338CA', marginBottom: 8 }}>Today</h2>
        <p style={{ color: '#475569' }}>Loading your workspace…</p>
      </div>
    )
  }

  if (!storeId) {
    return (
      <div>
        <h2 style={{ color: '#4338CA', marginBottom: 8 }}>Today</h2>
        <p style={{ color: '#475569' }}>Select a workspace to see today's performance.</p>
      </div>
    )
  }

  const baselineSalesTotal =
    summary?.previousSalesTotal ?? previousSummary?.salesTotal ?? null

  const salesVarianceValue =
    summary && baselineSalesTotal !== null ? summary.salesTotal - baselineSalesTotal : null

  const salesVariancePercentage =
    salesVarianceValue !== null && baselineSalesTotal && baselineSalesTotal !== 0
      ? (salesVarianceValue / baselineSalesTotal) * 100
      : null

  const variancePrimary =
    salesVarianceValue === null ? '—' : formatSignedCurrency(salesVarianceValue)

  let varianceSecondary = 'No prior sales data'
  if (baselineSalesTotal === null) {
    varianceSecondary = 'No prior sales data'
  } else if (baselineSalesTotal === 0) {
    varianceSecondary =
      summary && summary.salesTotal === 0
        ? 'No sales recorded today or yesterday'
        : 'No sales recorded yesterday'
  } else if (salesVariancePercentage !== null) {
    varianceSecondary = `${formatSignedPercentage(salesVariancePercentage)} vs ${formatCurrency(
      baselineSalesTotal,
    )} yesterday`
  }

  const averageBasketSize =
    summary && summary.salesCount > 0 ? summary.salesTotal / summary.salesCount : 0

  const averageBasketSecondary =
    summary && summary.salesCount > 0
      ? `Across ${formatNumber(summary.salesCount)} sale${summary.salesCount === 1 ? '' : 's'}`
      : 'No sales recorded today'

  const cards: Array<MetricCard | ProductsCard> = summary
    ? [
        {
          type: 'metric',
          title: 'Sales',
          primary: formatCurrency(summary.salesTotal),
          secondary: `${formatNumber(summary.salesCount)} sale${summary.salesCount === 1 ? '' : 's'}`,
        },
        {
          type: 'metric',
          title: 'Sales variance',
          primary: variancePrimary,
          secondary: varianceSecondary,
        },
        {
          type: 'metric',
          title: 'Average basket size',
          primary: formatCurrency(averageBasketSize),
          secondary: averageBasketSecondary,
        },
        {
          type: 'metric',
          title: 'Card payments',
          primary: formatCurrency(summary.cardTotal),
          secondary: 'Card & digital total',
        },
        {
          type: 'metric',
          title: 'Cash payments',
          primary: formatCurrency(summary.cashTotal),
          secondary: 'Cash counted today',
        },
        {
          type: 'metric',
          title: 'Receipts',
          primary: `${formatNumber(summary.receiptCount)} receipt${summary.receiptCount === 1 ? '' : 's'}`,
          secondary: `${formatNumber(summary.receiptUnits)} unit${summary.receiptUnits === 1 ? '' : 's'}`,
        },
        {
          type: 'metric',
          title: 'New customers',
          primary: formatNumber(summary.newCustomers),
          secondary: 'Added to your CRM',
        },
        {
          type: 'products',
          title: 'Top products',
          products: sortedTopProducts,
        },
      ]
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 200 }}>
          <h2 style={{ color: '#4338CA', marginBottom: 4 }}>Today</h2>
          <p style={{ color: '#475569', margin: 0 }}>Daily performance for {todayLabel}.</p>
        </div>

        <nav
          aria-label="Quick actions"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          {quickActions.map(action => (
            <Link
              key={action.to}
              to={action.to}
              aria-label={action.ariaLabel}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#F8FAFC',
                color: '#1E3A8A',
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 13,
                padding: '8px 16px',
                borderRadius: 9999,
                border: '1px solid #C7D2FE',
                minHeight: 36,
              }}
            >
              {action.label}
            </Link>
          ))}
        </nav>
      </header>

      <section
        aria-labelledby="today-kpis"
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 id="today-kpis" style={{ margin: 0, fontSize: 18, color: '#0F172A' }}>
            Key performance indicators
          </h3>
          {summaryLoading && (
            <span aria-live="polite" style={{ fontSize: 13, color: '#64748B' }}>
              Loading today&apos;s summary…
            </span>
          )}
          {summaryError && !summaryLoading && (
            <span role="status" style={{ fontSize: 13, color: '#DC2626' }}>
              {summaryError}
            </span>
          )}
        </div>

        {summaryLoading && cards.length === 0 ? (
          <p style={{ color: '#475569' }}>Loading today&apos;s summary…</p>
        ) : summaryError && cards.length === 0 ? (
          <p style={{ color: '#DC2626' }}>{summaryError}</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16,
            }}
          >
            {cards.map(card => {
              if (card.type === 'metric') {
                return (
                  <article
                    key={card.title}
                    style={{
                      background: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      borderRadius: 16,
                      padding: '16px 18px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 13, color: '#64748B' }}>{card.title}</span>
                    <strong style={{ fontSize: 24, color: '#0F172A' }}>{card.primary}</strong>
                    <span style={{ fontSize: 12, color: '#475569' }}>{card.secondary}</span>
                  </article>
                )
              }

              const hasProducts = card.products.length > 0

              return (
                <article
                  key={card.title}
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid #E2E8F0',
                    borderRadius: 16,
                    padding: '16px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 13, color: '#64748B' }}>{card.title}</span>
                  {hasProducts ? (
                    <ol
                      style={{
                        listStyle: 'none',
                        padding: 0,
                        margin: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      {card.products.map(product => (
                        <li
                          key={product.id}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          <span style={{ fontSize: 14, color: '#0F172A', fontWeight: 600 }}>
                            {product.name}
                          </span>
                          <span style={{ fontSize: 12, color: '#475569' }}>
                            {formatCurrency(product.salesTotal)} ·{' '}
                            {formatNumber(product.unitsSold)} unit
                            {product.unitsSold === 1 ? '' : 's'} sold
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <span style={{ fontSize: 12, color: '#475569' }}>
                      No product sales recorded today.
                    </span>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section
        aria-labelledby="today-activity"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 id="today-activity" style={{ margin: 0, fontSize: 18, color: '#0F172A' }}>
            Activity feed
          </h3>
          {activitiesLoading && (
            <span aria-live="polite" style={{ fontSize: 13, color: '#64748B' }}>
              Loading activity feed…
            </span>
          )}
          {activitiesError && !activitiesLoading && (
            <span role="status" style={{ fontSize: 13, color: '#DC2626' }}>
              {activitiesError}
            </span>
          )}
        </div>

        <div
          role="group"
          aria-label="Filter activity feed"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          {activityFilters.map(filter => {
            const isActive = activityFilter === filter.value
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => {
                  if (filter.value !== activityFilter) {
                    setActivityFilter(filter.value)
                  }
                }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 9999,
                  border: '1px solid',
                  borderColor: isActive ? '#4338CA' : '#CBD5F5',
                  background: isActive ? '#4338CA' : '#FFFFFF',
                  color: isActive ? '#FFFFFF' : '#4338CA',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isActive ? 'default' : 'pointer',
                }}
                disabled={isActive && activitiesLoading}
              >
                {filter.label}
              </button>
            )
          })}
        </div>

        {activitiesLoading && activities.length === 0 ? (
          <p style={{ color: '#475569' }}>Loading activity feed…</p>
        ) : activitiesError && activities.length === 0 ? (
          <p style={{ color: '#DC2626' }}>{activitiesError}</p>
        ) : activities.length === 0 ? (
          <p style={{ color: '#475569' }}>No activity recorded yet today.</p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {activities.map(activity => {
              const meta: string[] = []
              if (activity.type) meta.push(activity.type)
              if (activity.actor) meta.push(activity.actor)
              meta.push(formatTime(activity.at))

              return (
                <li
                  key={activity.id}
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid #E2E8F0',
                    borderRadius: 12,
                    padding: '14px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 14, color: '#0F172A', fontWeight: 600 }}>
                    {activity.message}
                  </span>
                  <span style={{ fontSize: 12, color: '#475569' }}>{meta.join(' • ')}</span>
                </li>
              )
            })}
          </ul>
        )}
        {hasMoreActivities && (
          <button
            type="button"
            onClick={loadMoreActivities}
            disabled={isLoadingMoreActivities || activitiesLoading}
            style={{
              alignSelf: 'flex-start',
              padding: '8px 14px',
              borderRadius: 9999,
              border: '1px solid #4338CA',
              background: isLoadingMoreActivities ? '#EEF2FF' : '#4338CA',
              color: isLoadingMoreActivities ? '#4338CA' : '#FFFFFF',
              fontSize: 13,
              fontWeight: 600,
              cursor: isLoadingMoreActivities || activitiesLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {isLoadingMoreActivities ? 'Loading more…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  )
}

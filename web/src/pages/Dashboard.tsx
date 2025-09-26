import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  type Timestamp,
} from 'firebase/firestore'
import { db } from '../firebase'

import { useAuthUser } from '../hooks/useAuthUser'
import { useActiveStore } from '../hooks/useActiveStore'
import { useToast } from '../components/ToastProvider'
import { AccessDenied } from '../components/AccessDenied'
import { canAccessFeature } from '../utils/permissions'
import type { AppFeature } from '../utils/permissions'
import {
  CUSTOMER_CACHE_LIMIT,
  PRODUCT_CACHE_LIMIT,
  SALES_CACHE_LIMIT,
  loadCachedCustomers,
  loadCachedProducts,
  loadCachedSales,
  saveCachedCustomers,
  saveCachedProducts,
  saveCachedSales,
} from '../utils/offlineCache'


type InventorySeverity = 'warning' | 'info' | 'critical'

type SaleRecord = {
  id: string
  total?: number
  createdAt?: Timestamp | Date | null
  items?: Array<{ productId: string; name?: string; price?: number; qty?: number }>
  payment?: {
    method?: string
    amountPaid?: number
    changeDue?: number
  }
}

type ProductRecord = {
  id: string
  name: string
  price?: number
  stockCount?: number
  minStock?: number
}

type CustomerRecord = {
  id: string
  name: string
  createdAt?: Timestamp | Date | null
}

type GoalTargets = {
  revenueTarget: number
  customerTarget: number
}

type MonthlyGoalDocument = {
  monthly?: Record<string, Partial<GoalTargets>>
}

const QUICK_LINKS: Array<{
  to: string
  title: string
  description: string
  feature: AppFeature
}> = [
  {
    to: '/products',
    title: 'Products',
    description: 'Manage your catalogue, update prices, and keep stock levels accurate.',
    feature: 'products',
  },
  {
    to: '/sell',
    title: 'Sell',
    description: 'Ring up a customer, track the cart, and record a sale in seconds.',
    feature: 'sell',
  },
  {
    to: '/receive',
    title: 'Receive',
    description: 'Log new inventory as it arrives so every aisle stays replenished.',
    feature: 'receive',
  },
  {
    to: '/close-day',
    title: 'Close Day',
    description: 'Balance the till, review totals, and lock in a clean daily report.',
    feature: 'close-day',
  },
  {
    to: '/settings',
    title: 'Settings',
    description: 'Configure staff, taxes, and other controls that keep your shop running.',
    feature: 'settings',
  },
]

const MS_PER_DAY = 1000 * 60 * 60 * 24
const DEFAULT_REVENUE_TARGET = 5000
const DEFAULT_CUSTOMER_TARGET = 50

type PresetRangeId = 'today' | '7d' | '30d' | 'month' | 'custom'

const RANGE_PRESETS: Array<{
  id: PresetRangeId
  label: string
  getRange?: (today: Date) => { start: Date; end: Date }
}> = [
  {
    id: 'today',
    label: 'Today',
    getRange: today => ({ start: startOfDay(today), end: endOfDay(today) })
  },
  {
    id: '7d',
    label: 'Last 7 days',
    getRange: today => ({ start: startOfDay(addDays(today, -6)), end: endOfDay(today) })
  },
  {
    id: '30d',
    label: 'Last 30 days',
    getRange: today => ({ start: startOfDay(addDays(today, -29)), end: endOfDay(today) })
  },
  {
    id: 'month',
    label: 'This month',
    getRange: today => ({ start: startOfMonth(today), end: endOfDay(today) })
  },
  {
    id: 'custom',
    label: 'Custom range',
  }
]

function asDate(value?: Timestamp | Date | null) {
  if (!value) return null
  if (value instanceof Date) return value
  try {
    return value.toDate()
  } catch (error) {
    return null
  }
}

function addDays(base: Date, days: number) {
  const copy = new Date(base)
  copy.setDate(copy.getDate() + days)
  return copy
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date) {
  return endOfDay(new Date(date.getFullYear(), date.getMonth() + 1, 0))
}

function formatAmount(value: number) {
  return `GHS ${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatPercent(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function formatHourRange(hour: number) {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const start = new Date()
  start.setHours(hour, 0, 0, 0)
  const end = new Date(start)
  end.setHours(hour + 1)
  return `${formatter.format(start)} – ${formatter.format(end)}`
}

function differenceInCalendarDays(start: Date, end: Date) {
  const startAtMidnight = startOfDay(start).getTime()
  const endAtMidnight = startOfDay(end).getTime()
  return Math.round((endAtMidnight - startAtMidnight) / MS_PER_DAY)
}

function enumerateDaysBetween(start: Date, end: Date) {
  const days: Date[] = []
  let cursor = startOfDay(start)
  const final = startOfDay(end)
  while (cursor.getTime() <= final.getTime()) {
    days.push(new Date(cursor))
    cursor = addDays(cursor, 1)
  }
  return days
}

function formatDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDateRange(start: Date, end: Date) {
  const sameYear = start.getFullYear() === end.getFullYear()
  const startFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  })
  const endFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `${startFormatter.format(start)} – ${endFormatter.format(end)}`
}

function buildDailyMetricSeries(
  sales: SaleRecord[],
  start: Date,
  end: Date,
  metric: 'revenue' | 'count' | 'ticket'
) {
  const buckets = new Map<string, { revenue: number; count: number }>()
  sales.forEach(sale => {
    const created = asDate(sale.createdAt)
    if (!created) return
    const key = formatDateKey(created)
    const bucket = buckets.get(key) ?? { revenue: 0, count: 0 }
    bucket.revenue += sale.total ?? 0
    bucket.count += 1
    buckets.set(key, bucket)
  })

  return enumerateDaysBetween(start, end).map(day => {
    const bucket = buckets.get(formatDateKey(day))
    if (!bucket) {
      return 0
    }
    if (metric === 'revenue') return bucket.revenue
    if (metric === 'count') return bucket.count
    return bucket.count > 0 ? bucket.revenue / bucket.count : 0
  })
}

function formatMonthInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function parseMonthInput(value: string) {
  if (!value) return null
  const [year, month] = value.split('-').map(Number)
  if (!year || !month) return null
  return new Date(year, month - 1, 1)
}

function parseDateInput(value: string) {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

export default function Dashboard() {
  const { storeId: STORE_ID, role, isLoading: storeLoading, error: storeError } = useActiveStore()

  const [sales, setSales] = useState<SaleRecord[]>([])
  const [products, setProducts] = useState<ProductRecord[]>([])
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const { publish } = useToast()
  const [monthlyGoals, setMonthlyGoals] = useState<Record<string, GoalTargets>>({})
  const [selectedGoalMonth, setSelectedGoalMonth] = useState(() => formatMonthInput(new Date()))
  const [goalFormValues, setGoalFormValues] = useState({
    revenueTarget: String(DEFAULT_REVENUE_TARGET),
    customerTarget: String(DEFAULT_CUSTOMER_TARGET)
  })
  const [goalFormTouched, setGoalFormTouched] = useState(false)
  const [isSavingGoals, setIsSavingGoals] = useState(false)
  const [selectedRangeId, setSelectedRangeId] = useState<PresetRangeId>('today')
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>({ start: '', end: '' })

  const hasAccess = canAccessFeature(role, 'dashboard')
  const visibleQuickLinks = useMemo(
    () => QUICK_LINKS.filter(link => canAccessFeature(role, link.feature)),
    [role],
  )

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    let cancelled = false

    loadCachedSales<SaleRecord>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setSales(cached)
        }
      })
      .catch(error => {
        console.warn('[dashboard] Failed to load cached sales', error)
      })

    const q = query(
      collection(db, 'sales'),
      where('storeId', '==', STORE_ID),
      orderBy('createdAt', 'desc'),
      limit(SALES_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snapshot => {
      const rows: SaleRecord[] = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<SaleRecord, 'id'>),
      }))
      setSales(rows)
      saveCachedSales(STORE_ID, rows).catch(error => {
        console.warn('[dashboard] Failed to cache sales', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    let cancelled = false

    loadCachedProducts<ProductRecord>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setProducts(cached)
        }
      })
      .catch(error => {
        console.warn('[dashboard] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', STORE_ID),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snapshot => {
      const rows: ProductRecord[] = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<ProductRecord, 'id'>),
      }))
      setProducts(rows)
      saveCachedProducts(STORE_ID, rows).catch(error => {
        console.warn('[dashboard] Failed to cache products', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    let cancelled = false

    loadCachedCustomers<CustomerRecord>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setCustomers(cached)
        }
      })
      .catch(error => {
        console.warn('[dashboard] Failed to load cached customers', error)
      })

    const q = query(
      collection(db, 'customers'),
      where('storeId', '==', STORE_ID),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(CUSTOMER_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snapshot => {
      const rows: CustomerRecord[] = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CustomerRecord, 'id'>),
      }))
      setCustomers(rows)
      saveCachedCustomers(STORE_ID, rows).catch(error => {
        console.warn('[dashboard] Failed to cache customers', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [STORE_ID, hasAccess])

  useEffect(() => {
    if (!STORE_ID || !hasAccess) return
    const ref = doc(db, 'storeGoals', STORE_ID)
    return onSnapshot(ref, snapshot => {
      const data = snapshot.data() as MonthlyGoalDocument | undefined
      if (!data?.monthly) {
        setMonthlyGoals({})
        return
      }
      const parsed: Record<string, GoalTargets> = {}
      Object.entries(data.monthly).forEach(([month, entry]) => {
        parsed[month] = {
          revenueTarget:
            typeof entry?.revenueTarget === 'number' ? entry.revenueTarget : DEFAULT_REVENUE_TARGET,
          customerTarget:
            typeof entry?.customerTarget === 'number' ? entry.customerTarget : DEFAULT_CUSTOMER_TARGET,
        }
      })
      setMonthlyGoals(parsed)
    })
  }, [STORE_ID, hasAccess])

  useEffect(() => {
    setGoalFormTouched(false)
  }, [selectedGoalMonth])

  useEffect(() => {
    if (goalFormTouched) return
    const active = monthlyGoals[selectedGoalMonth]
    setGoalFormValues({
      revenueTarget: String(active?.revenueTarget ?? DEFAULT_REVENUE_TARGET),
      customerTarget: String(active?.customerTarget ?? DEFAULT_CUSTOMER_TARGET),
    })
  }, [monthlyGoals, selectedGoalMonth, goalFormTouched])

  const today = useMemo(() => new Date(), [sales])
  const defaultMonthKey = useMemo(() => formatMonthInput(today), [today])
  const rangeInfo = useMemo(() => {
    const fallbackPreset = RANGE_PRESETS.find(option => option.id === 'today')
    const resolvedFallback = fallbackPreset?.getRange?.(today) ?? {
      start: startOfDay(today),
      end: endOfDay(today)
    }

    if (selectedRangeId === 'custom') {
      const startDate = parseDateInput(customRange.start)
      const endDate = parseDateInput(customRange.end)
      if (startDate && endDate && startDate <= endDate) {
        return {
          rangeStart: startOfDay(startDate),
          rangeEnd: endOfDay(endDate),
          resolvedRangeId: 'custom' as PresetRangeId,
        }
      }
      return {
        rangeStart: resolvedFallback.start,
        rangeEnd: resolvedFallback.end,
        resolvedRangeId: 'today' as PresetRangeId,
      }
    }

    const preset = RANGE_PRESETS.find(option => option.id === selectedRangeId)
    if (preset?.getRange) {
      const range = preset.getRange(today)
      return {
        rangeStart: range.start,
        rangeEnd: range.end,
        resolvedRangeId: preset.id,
      }
    }

    return {
      rangeStart: resolvedFallback.start,
      rangeEnd: resolvedFallback.end,
      resolvedRangeId: 'today' as PresetRangeId,
    }
  }, [today, selectedRangeId, customRange.start, customRange.end])

  const { rangeStart, rangeEnd, resolvedRangeId } = rangeInfo
  const rangeDays = differenceInCalendarDays(rangeStart, rangeEnd) + 1
  const previousRangeStart = addDays(rangeStart, -rangeDays)
  const previousRangeEnd = addDays(rangeStart, -1)

  const currentSales = useMemo(
    () =>
      sales.filter(record => {
        const created = asDate(record.createdAt)
        return created ? created >= rangeStart && created <= rangeEnd : false
      }),
    [sales, rangeStart, rangeEnd]
  )

  const previousSales = useMemo(
    () =>
      sales.filter(record => {
        const created = asDate(record.createdAt)
        return created ? created >= previousRangeStart && created <= previousRangeEnd : false
      }),
    [sales, previousRangeStart, previousRangeEnd]
  )

  const currentRevenue = useMemo(
    () => currentSales.reduce((sum, sale) => sum + (sale.total ?? 0), 0),
    [currentSales]
  )
  const previousRevenue = useMemo(
    () => previousSales.reduce((sum, sale) => sum + (sale.total ?? 0), 0),
    [previousSales]
  )

  const currentTicket = currentSales.length ? currentRevenue / currentSales.length : 0
  const previousTicket = previousSales.length ? previousRevenue / previousSales.length : 0

  const salesChange = previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue) * 100 : null
  const ticketChange = previousTicket > 0 ? ((currentTicket - previousTicket) / previousTicket) * 100 : null
  const salesCountChange = previousSales.length > 0
    ? ((currentSales.length - previousSales.length) / previousSales.length) * 100
    : null

  const inventoryValue = products.reduce((sum, product) => {
    const stock = product.stockCount ?? 0
    const price = product.price ?? 0
    return sum + stock * price
  }, 0)

  const lowStock = products
    .map(product => {
      const stock = product.stockCount ?? 0
      const minStock = product.minStock ?? 5
      if (stock > minStock) return null
      const severity: InventorySeverity = stock <= 0 ? 'critical' : stock <= minStock ? 'warning' : 'info'
      const status = stock <= 0 ? 'Out of stock' : `Low (${stock} remaining)`
      return {
        sku: product.id,
        name: product.name,
        status,
        severity,
      }
    })
    .filter(Boolean) as Array<{ sku: string; name: string; status: string; severity: InventorySeverity }>

  const outOfStockCount = products.filter(product => (product.stockCount ?? 0) <= 0).length

  const hourBuckets = currentSales.reduce((acc, sale) => {
    const created = asDate(sale.createdAt)
    if (!created) return acc
    const hour = created.getHours()
    const current = acc.get(hour) ?? 0
    acc.set(hour, current + (sale.total ?? 0))
    return acc
  }, new Map<number, number>())

  let peakHour: { hour: number; total: number } | null = null
  hourBuckets.forEach((total, hour) => {
    if (!peakHour || total > peakHour.total) {
      peakHour = { hour, total }
    }
  })

  const itemTotals = currentSales.reduce((acc, sale) => {
    const items = sale.items ?? []
    items.forEach(item => {
      const qty = item.qty ?? 0
      if (!qty) return
      const key = item.productId
      if (!key) return
      const existing = acc.get(key) ?? { name: item.name ?? 'Unnamed product', qty: 0 }
      existing.qty += qty
      if (item.name && !existing.name) {
        existing.name = item.name
      }
      acc.set(key, existing)
    })
    return acc
  }, new Map<string, { name: string; qty: number }>())

  let topItem: { name: string; qty: number } | null = null
  itemTotals.forEach(value => {
    if (!topItem || value.qty > topItem.qty) {
      topItem = value
    }
  })

  const comparisonLabel = previousSales.length
    ? `vs previous ${rangeDays === 1 ? 'day' : `${rangeDays} days`}`
    : 'No prior data'

  const rangeLabel = useMemo(() => {
    if (resolvedRangeId === 'custom') {
      return formatDateRange(rangeStart, rangeEnd)
    }
    return RANGE_PRESETS.find(option => option.id === resolvedRangeId)?.label ?? 'Selected range'
  }, [resolvedRangeId, rangeStart, rangeEnd])

  const revenueSeries = useMemo(
    () => buildDailyMetricSeries(currentSales, rangeStart, rangeEnd, 'revenue'),
    [currentSales, rangeStart, rangeEnd]
  )
  const previousRevenueSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'revenue'),
    [previousSales, previousRangeStart, previousRangeEnd]
  )
  const ticketSeries = useMemo(
    () => buildDailyMetricSeries(currentSales, rangeStart, rangeEnd, 'ticket'),
    [currentSales, rangeStart, rangeEnd]
  )
  const previousTicketSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'ticket'),
    [previousSales, previousRangeStart, previousRangeEnd]
  )
  const salesCountSeries = useMemo(
    () => buildDailyMetricSeries(currentSales, rangeStart, rangeEnd, 'count'),
    [currentSales, rangeStart, rangeEnd]
  )
  const previousSalesCountSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'count'),
    [previousSales, previousRangeStart, previousRangeEnd]
  )

  const metrics = [
    {
      id: 'revenue',
      title: 'Revenue',
      subtitle: rangeLabel,
      value: formatAmount(currentRevenue),
      changePercent: salesChange,
      changeDescription: comparisonLabel,
      sparkline: revenueSeries,
      comparisonSparkline: previousRevenueSeries,
    },
    {
      id: 'ticket',
      title: 'Average basket',
      subtitle: rangeLabel,
      value: formatAmount(currentTicket),
      changePercent: ticketChange,
      changeDescription: comparisonLabel,
      sparkline: ticketSeries,
      comparisonSparkline: previousTicketSeries,
    },
    {
      id: 'transactions',
      title: 'Transactions recorded',
      subtitle: rangeLabel,
      value: `${currentSales.length}`,
      changePercent: salesCountChange,
      changeDescription: comparisonLabel,
      sparkline: salesCountSeries,
      comparisonSparkline: previousSalesCountSeries,
    },
    {
      id: 'inventory',
      title: 'Inventory value',
      subtitle: 'Current snapshot',
      value: formatAmount(inventoryValue),
      changePercent: null,
      changeDescription: `${outOfStockCount} out-of-stock`,
      sparkline: null,
      comparisonSparkline: null,
    },
  ]

  const goalMonthDate = useMemo(() => parseMonthInput(selectedGoalMonth) ?? startOfMonth(today), [selectedGoalMonth, today])
  const goalMonthStart = useMemo(() => startOfMonth(goalMonthDate), [goalMonthDate])
  const goalMonthEnd = useMemo(() => endOfMonth(goalMonthDate), [goalMonthDate])
  const goalMonthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
      }).format(goalMonthDate),
    [goalMonthDate]
  )

  const goalMonthRevenue = useMemo(
    () =>
      sales.reduce((sum, sale) => {
        const created = asDate(sale.createdAt)
        if (!created || created < goalMonthStart || created > goalMonthEnd) return sum
        return sum + (sale.total ?? 0)
      }, 0),
    [sales, goalMonthStart, goalMonthEnd]
  )

  const goalMonthCustomers = useMemo(
    () =>
      customers.reduce((count, customer) => {
        const created = asDate(customer.createdAt)
        if (!created || created < goalMonthStart || created > goalMonthEnd) return count
        return count + 1
      }, 0),
    [customers, goalMonthStart, goalMonthEnd]
  )

  const activeTargets = useMemo(() => {
    const entry = monthlyGoals[selectedGoalMonth]
    return {
      revenueTarget: entry?.revenueTarget ?? DEFAULT_REVENUE_TARGET,
      customerTarget: entry?.customerTarget ?? DEFAULT_CUSTOMER_TARGET,
    }
  }, [monthlyGoals, selectedGoalMonth])

  const goals = [
    {
      title: `${goalMonthLabel} revenue`,
      value: formatAmount(goalMonthRevenue),
      target: `Goal ${formatAmount(activeTargets.revenueTarget)}`,
      progress: Math.min(1, activeTargets.revenueTarget ? goalMonthRevenue / activeTargets.revenueTarget : 0),
    },
    {
      title: `${goalMonthLabel} new customers`,
      value: `${goalMonthCustomers}`,
      target: `Goal ${activeTargets.customerTarget}`,
      progress: Math.min(1, activeTargets.customerTarget ? goalMonthCustomers / activeTargets.customerTarget : 0),
    },
  ]

  const rangeSummary = useMemo(
    () => formatDateRange(rangeStart, rangeEnd),
    [rangeStart, rangeEnd]
  )
  const rangeDaysLabel = rangeDays === 1 ? '1 day' : `${rangeDays} days`
  const showCustomHint = selectedRangeId === 'custom' && resolvedRangeId !== 'custom'

  function handleRangePresetChange(id: PresetRangeId) {
    setSelectedRangeId(id)
  }

  function handleCustomDateChange(field: 'start' | 'end', value: string) {
    setSelectedRangeId('custom')
    setCustomRange(current => ({ ...current, [field]: value }))
  }

  function handleGoalMonthChange(value: string) {
    setSelectedGoalMonth(value || defaultMonthKey)
  }

  function handleGoalInputChange(field: 'revenueTarget' | 'customerTarget', value: string) {
    setGoalFormTouched(true)
    setGoalFormValues(current => ({ ...current, [field]: value }))
  }

  async function handleGoalSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!STORE_ID) return
    setIsSavingGoals(true)
    try {
      const revenueValue = Number(goalFormValues.revenueTarget)
      const customerValue = Number(goalFormValues.customerTarget)
      const revenueTarget = Number.isFinite(revenueValue) ? Math.max(0, revenueValue) : 0
      const customerTarget = Number.isFinite(customerValue) ? Math.max(0, customerValue) : 0
      const monthKey = selectedGoalMonth || defaultMonthKey

      await setDoc(
        doc(db, 'storeGoals', STORE_ID),
        {
          storeId: STORE_ID,
          monthly: {
            [monthKey]: {
              revenueTarget,
              customerTarget,
            },
          },
        },
        { merge: true }
      )

      setGoalFormTouched(false)
      setGoalFormValues({
        revenueTarget: String(revenueTarget),
        customerTarget: String(customerTarget),
      })
      publish({ tone: 'success', message: `Goals updated for ${goalMonthLabel}.` })
    } catch (error) {
      console.error('[dashboard] Unable to save goals', error)
      publish({ tone: 'error', message: 'Unable to save goals right now.' })
    } finally {
      setIsSavingGoals(false)
    }
  }

  const inventoryAlerts = lowStock.slice(0, 5)

  const teamCallouts = [
    {
      label: 'Peak sales hour',
      value: peakHour ? formatHourRange(peakHour.hour) : '—',
      description: peakHour
        ? `${formatAmount(peakHour.total)} sold during this hour across the selected range.`
        : 'No sales recorded for this range yet.',
    },
    {
      label: 'Top product',
      value: topItem ? topItem.name : '—',
      description: topItem
        ? `${topItem.qty} sold across the selected range.`
        : 'Record sales to surface bestsellers.',
    },
    {
      label: 'Inventory alerts',
      value: `${lowStock.length} low / ${outOfStockCount} out`,
      description: lowStock.length || outOfStockCount
        ? 'Review products that need restocking.'
        : 'All products are above minimum stock.',
    },
  ]

  if (!storeLoading && !hasAccess) {
    return <AccessDenied feature="dashboard" role={role ?? null} />
  }

  if (storeLoading) {
    return <div>Loading…</div>
  }

  if (!STORE_ID) {
    return <div>We were unable to determine your store access. Please sign out and back in.</div>
  }

  return (
    <div>
      <h2 style={{ color: '#4338CA', marginBottom: 8 }}>Dashboard</h2>
      {storeError && <p style={{ color: '#b91c1c', marginBottom: 12 }}>{storeError}</p>}
      <p style={{ color: '#475569', marginBottom: 24 }}>
        Welcome back! Choose what you’d like to work on — the most important Sedifex pages are just one tap away.
      </p>

      <section
        style={{
          background: '#FFFFFF',
          borderRadius: 20,
          border: '1px solid #E2E8F0',
          padding: '20px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          marginBottom: 24
        }}
        aria-label="Time range controls"
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>Time range</h3>
            <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
              Pick the window you want to analyse. All charts and KPIs update instantly.
            </p>
          </div>
          <div role="group" aria-label="Quick ranges" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {RANGE_PRESETS.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => handleRangePresetChange(option.id)}
                aria-pressed={resolvedRangeId === option.id}
                style={{
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: resolvedRangeId === option.id ? '1px solid #4338CA' : '1px solid #E2E8F0',
                  background: resolvedRangeId === option.id ? '#4338CA' : '#F8FAFC',
                  color: resolvedRangeId === option.id ? '#FFFFFF' : '#1E293B',
                  fontSize: 13,
                  fontWeight: 600,
                  boxShadow: resolvedRangeId === option.id ? '0 4px 12px rgba(67, 56, 202, 0.25)' : 'none',
                  cursor: 'pointer'
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'center'
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' }}>
            <span>From</span>
            <input
              type="date"
              value={customRange.start}
              onChange={event => handleCustomDateChange('start', event.target.value)}
              style={{
                borderRadius: 8,
                border: '1px solid #CBD5F5',
                padding: '6px 10px',
                fontSize: 13,
              }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' }}>
            <span>To</span>
            <input
              type="date"
              value={customRange.end}
              onChange={event => handleCustomDateChange('end', event.target.value)}
              style={{
                borderRadius: 8,
                border: '1px solid #CBD5F5',
                padding: '6px 10px',
                fontSize: 13,
              }}
            />
          </label>
          <span style={{ fontSize: 13, color: '#1E293B', fontWeight: 600 }}>
            Showing {rangeSummary} ({rangeDaysLabel})
          </span>
        </div>

        {showCustomHint && (
          <p style={{ margin: 0, fontSize: 12, color: '#DC2626' }}>
            Select both start and end dates to apply your custom range. We’re showing today’s data until then.
          </p>
        )}
      </section>

      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          marginBottom: 32
        }}
        aria-label="Business metrics overview"
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16
          }}
        >
          {metrics.map(metric => {
            const change = metric.changePercent
            const color = change === null ? '#475569' : change < 0 ? '#DC2626' : '#16A34A'
            const icon = change === null ? '▬' : change < 0 ? '▼' : '▲'
            const changeText = change !== null ? formatPercent(change) : '—'
            return (
              <article
                key={metric.title}
                style={{
                  background: '#FFFFFF',
                  borderRadius: 16,
                  padding: '18px 20px',
                  border: '1px solid #E2E8F0',
                  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {metric.title}
                </div>
                <div style={{ fontSize: 30, fontWeight: 700, color: '#0F172A', lineHeight: 1 }}>
                  {metric.value}
                </div>
                <div style={{ fontSize: 13, color: '#64748B' }}>{metric.subtitle}</div>
                <div style={{ height: 56 }} aria-hidden="true">
                  {metric.sparkline && metric.sparkline.length ? (
                    <Sparkline
                      data={metric.sparkline}
                      comparisonData={metric.comparisonSparkline ?? undefined}
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: '#94A3B8',
                        display: 'flex',
                        alignItems: 'center',
                        height: '100%'
                      }}
                    >
                      Snapshot metric
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: '999px',
                      background: '#EEF2FF',
                      color,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                    aria-hidden="true"
                  >
                    {icon}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color }}>{changeText}</span>
                  <span style={{ fontSize: 13, color: '#64748B' }}>{metric.changeDescription}</span>
                </div>
              </article>
            )
          })}
        </div>

        <div
          style={{
            background: '#F1F5F9',
            borderRadius: 18,
            border: '1px solid #E2E8F0',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: 20
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0F172A' }}>Monthly goals</h3>
              <p style={{ margin: 0, fontSize: 13, color: '#64748B' }}>
                Set targets per branch and keep teams aligned on what success looks like.
              </p>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#475569' }}>
              <span style={{ fontWeight: 600 }}>Month</span>
              <input
                type="month"
                value={selectedGoalMonth}
                onChange={event => handleGoalMonthChange(event.target.value)}
                style={{
                  borderRadius: 8,
                  border: '1px solid #CBD5F5',
                  padding: '6px 10px',
                  fontSize: 13,
                  background: '#FFFFFF'
                }}
              />
            </label>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12
            }}
          >
            {goals.map(goal => (
              <article
                key={goal.title}
                style={{
                  background: '#FFFFFF',
                  borderRadius: 14,
                  padding: '16px 18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  border: '1px solid #E2E8F0'
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {goal.title}
                </div>
                <div style={{ fontSize: 26, fontWeight: 700, color: '#0F172A', lineHeight: 1 }}>
                  {goal.value}
                </div>
                <div style={{ fontSize: 13, color: '#475569' }}>{goal.target}</div>
                <div
                  role="progressbar"
                  aria-valuenow={Math.round(goal.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  style={{
                    position: 'relative',
                    height: 8,
                    borderRadius: 999,
                    background: '#E2E8F0',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: `${Math.round(goal.progress * 100)}%`,
                      background: '#4338CA'
                    }}
                  />
                </div>
              </article>
            ))}
          </div>

          <form
            onSubmit={handleGoalSubmit}
            style={{ display: 'grid', gap: 12 }}
          >
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))'
              }}
            >
              <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#475569' }} htmlFor="goal-revenue">
                <span style={{ fontWeight: 600 }}>Revenue goal (GHS)</span>
                <input
                  id="goal-revenue"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={goalFormValues.revenueTarget}
                  onChange={event => handleGoalInputChange('revenueTarget', event.target.value)}
                  style={{
                    borderRadius: 8,
                    border: '1px solid #CBD5F5',
                    padding: '8px 10px',
                    fontSize: 14,
                    background: '#FFFFFF'
                  }}
                />
              </label>
              <label style={{ display: 'grid', gap: 6, fontSize: 13, color: '#475569' }} htmlFor="goal-customers">
                <span style={{ fontWeight: 600 }}>New customers goal</span>
                <input
                  id="goal-customers"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={goalFormValues.customerTarget}
                  onChange={event => handleGoalInputChange('customerTarget', event.target.value)}
                  style={{
                    borderRadius: 8,
                    border: '1px solid #CBD5F5',
                    padding: '8px 10px',
                    fontSize: 14,
                    background: '#FFFFFF'
                  }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="submit"
                className="primary-button"
                disabled={isSavingGoals}
                style={{
                  background: '#4338CA',
                  border: 'none',
                  borderRadius: 999,
                  color: '#FFFFFF',
                  padding: '10px 18px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                {isSavingGoals ? 'Saving…' : 'Save goals'}
              </button>
              <span style={{ fontSize: 12, color: '#475569' }}>
                Targets are saved for {goalMonthLabel}. Adjust them anytime to keep your team focused.
              </span>
            </div>
          </form>
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 20,
          marginBottom: 32
        }}
      >
        <article
          style={{
            background: '#FFFFFF',
            borderRadius: 20,
            border: '1px solid #E2E8F0',
            padding: '20px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Quick links</h3>
              <p style={{ fontSize: 13, color: '#64748B' }}>Hop straight into the workspace you need.</p>
            </div>
          </div>
          <ul style={{ display: 'grid', gap: 12, listStyle: 'none', margin: 0, padding: 0 }}>
            {visibleQuickLinks.map(link => (
              <li key={link.to}>
                <Link
                  to={link.to}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: '#F8FAFC',
                    borderRadius: 12,
                    padding: '14px 16px',
                    textDecoration: 'none',
                    color: '#1E3A8A',
                    border: '1px solid transparent'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{link.title}</div>
                    <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>{link.description}</p>
                  </div>
                  <span aria-hidden="true" style={{ fontWeight: 700, color: '#4338CA' }}>
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </article>

        <article
          style={{
            background: '#FFFFFF',
            borderRadius: 20,
            border: '1px solid #E2E8F0',
            padding: '20px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Inventory alerts</h3>
            <p style={{ fontSize: 13, color: '#64748B' }}>
              Watch products that are running low so the floor team can replenish quickly.
            </p>
          </div>

          {inventoryAlerts.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {inventoryAlerts.map(item => (
                <li
                  key={item.sku}
                  style={{
                    border: '1px solid #E2E8F0',
                    borderRadius: 12,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    background: '#F8FAFC'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: '#0F172A' }}>{item.name}</span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: item.severity === 'critical' ? '#DC2626' : item.severity === 'warning' ? '#C2410C' : '#2563EB'
                      }}
                    >
                      {item.status}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: '#64748B' }}>SKU: {item.sku}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: 13, color: '#475569' }}>All inventory levels are healthy.</p>
          )}
        </article>

        <article
          style={{
            background: '#FFFFFF',
            borderRadius: 20,
            border: '1px solid #E2E8F0',
            padding: '20px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Team callouts</h3>
            <p style={{ fontSize: 13, color: '#64748B' }}>
              Share insights with staff so everyone knows what needs attention in this range.
            </p>
          </div>

          <dl style={{ margin: 0, display: 'grid', gap: 12 }}>
            {teamCallouts.map(item => (
              <div
                key={item.label}
                style={{
                  display: 'grid',
                  gap: 4,
                  background: '#F8FAFC',
                  borderRadius: 12,
                  border: '1px solid #E2E8F0',
                  padding: '12px 14px'
                }}
              >
                <dt style={{ fontSize: 12, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {item.label}
                </dt>
                <dd style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{item.value}</dd>
                <dd style={{ margin: 0, fontSize: 13, color: '#475569' }}>{item.description}</dd>
              </div>
            ))}
          </dl>
        </article>
      </section>
    </div>
  )
}

type SparklineProps = {
  data: number[]
  comparisonData?: number[]
  color?: string
  comparisonColor?: string
}

function Sparkline({
  data,
  comparisonData,
  color = '#4338CA',
  comparisonColor = '#A5B4FC',
}: SparklineProps) {
  if (!data.length) {
    return null
  }

  const width = Math.max(80, data.length * 12)
  const height = 48
  const allValues = [...data, ...(comparisonData ?? [])]
  const maxValue = Math.max(...allValues, 0)
  const minValue = Math.min(...allValues, 0)
  const range = maxValue - minValue || 1

  const createPoints = (series: number[]) =>
    series
      .map((value, index) => {
        const x = series.length > 1 ? (index / (series.length - 1)) * (width - 4) + 2 : width / 2
        const normalized = (value - minValue) / range
        const y = height - 4 - normalized * (height - 8)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const primaryPoints = createPoints(data)
  const comparisonPoints = comparisonData && comparisonData.length ? createPoints(comparisonData) : null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="48"
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      {comparisonPoints && (
        <polyline
          points={comparisonPoints}
          fill="none"
          stroke={comparisonColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="4 4"
          opacity={0.7}
        />
      )}
      <polyline
        points={primaryPoints}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  )
}


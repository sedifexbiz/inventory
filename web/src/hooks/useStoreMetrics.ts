import { useEffect, useMemo, useState } from 'react'
import { collection, doc, limit, onSnapshot, orderBy, query, setDoc, where, type Timestamp } from 'firebase/firestore'

import { db } from '../firebase'
import { useAuthUser } from './useAuthUser'
import { useActiveStore } from './useActiveStore'
import { useToast } from '../components/ToastProvider'
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
  storeId?: string | null
}

type ProductRecord = {
  id: string
  name: string
  price?: number
  stockCount?: number
  minStock?: number
  createdAt?: unknown
  updatedAt?: unknown
  storeId?: string | null
}

type CustomerRecord = {
  id: string
  name: string
  displayName?: string
  createdAt?: Timestamp | Date | null
  storeId?: string | null
}

type GoalTargets = {
  revenueTarget: number
  customerTarget: number
}

type MonthlyGoalDocument = {
  monthly?: Record<string, Partial<GoalTargets>>
}

type PresetRangeId = 'today' | '7d' | '30d' | 'month' | 'custom'

type RangePreset = {
  id: PresetRangeId
  label: string
  getRange?: (today: Date) => { start: Date; end: Date }
}

type MetricCard = {
  id: string
  title: string
  subtitle: string
  value: string
  changePercent: number | null
  changeDescription: string
  sparkline: number[] | null
  comparisonSparkline: number[] | null
}

type GoalProgress = {
  title: string
  value: string
  target: string
  progress: number
}

type InventoryAlert = {
  sku: string
  name: string
  status: string
  severity: InventorySeverity
}

type TeamCallout = {
  label: string
  value: string
  description: string
}

type GoalFormValues = {
  revenueTarget: string
  customerTarget: string
}

type CustomRange = { start: string; end: string }

type UseStoreMetricsResult = {
  rangePresets: RangePreset[]
  selectedRangeId: PresetRangeId
  resolvedRangeId: PresetRangeId
  customRange: CustomRange
  handleRangePresetChange: (id: PresetRangeId) => void
  handleCustomDateChange: (field: 'start' | 'end', value: string) => void
  rangeSummary: string
  rangeDaysLabel: string
  showCustomHint: boolean
  metrics: MetricCard[]
  goals: GoalProgress[]
  goalMonthLabel: string
  selectedGoalMonth: string
  handleGoalMonthChange: (value: string) => void
  goalFormValues: GoalFormValues
  handleGoalInputChange: (field: keyof GoalFormValues, value: string) => void
  handleGoalSubmit: (event: React.FormEvent) => Promise<void>
  isSavingGoals: boolean
  inventoryAlerts: InventoryAlert[]
  teamCallouts: TeamCallout[]
}

const MS_PER_DAY = 1000 * 60 * 60 * 24
const DEFAULT_REVENUE_TARGET = 5000
const DEFAULT_CUSTOMER_TARGET = 50

const RANGE_PRESETS: RangePreset[] = [
  {
    id: 'today',
    label: 'Today',
    getRange: today => ({ start: startOfDay(today), end: endOfDay(today) }),
  },
  {
    id: '7d',
    label: 'Last 7 days',
    getRange: today => ({ start: startOfDay(addDays(today, -6)), end: endOfDay(today) }),
  },
  {
    id: '30d',
    label: 'Last 30 days',
    getRange: today => ({ start: startOfDay(addDays(today, -29)), end: endOfDay(today) }),
  },
  {
    id: 'month',
    label: 'This month',
    getRange: today => ({ start: startOfMonth(today), end: endOfDay(today) }),
  },
  {
    id: 'custom',
    label: 'Custom range',
  },
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

function buildDailyMetricSeries(
  sales: SaleRecord[],
  start: Date,
  end: Date,
  metric: 'revenue' | 'count' | 'ticket',
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

export function useStoreMetrics(): UseStoreMetricsResult {
  const authUser = useAuthUser()
  const { storeId: activeStoreId } = useActiveStore()
  const { publish } = useToast()

  const [sales, setSales] = useState<SaleRecord[]>([])
  const [products, setProducts] = useState<ProductRecord[]>([])
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [monthlyGoals, setMonthlyGoals] = useState<Record<string, GoalTargets>>({})
  const [selectedGoalMonth, setSelectedGoalMonth] = useState(() => formatMonthInput(new Date()))
  const [goalFormValues, setGoalFormValues] = useState<GoalFormValues>({
    revenueTarget: String(DEFAULT_REVENUE_TARGET),
    customerTarget: String(DEFAULT_CUSTOMER_TARGET),
  })
  const [goalFormTouched, setGoalFormTouched] = useState(false)
  const [isSavingGoals, setIsSavingGoals] = useState(false)
  const [selectedRangeId, setSelectedRangeId] = useState<PresetRangeId>('today')
  const [customRange, setCustomRange] = useState<CustomRange>({ start: '', end: '' })

  const goalDocumentId = useMemo(
    () => activeStoreId ?? `user-${authUser?.uid ?? 'default'}`,
    [activeStoreId, authUser?.uid],
  )

  useEffect(() => {
    let cancelled = false

    if (!activeStoreId) {
      setSales([])
      return () => {
        cancelled = true
      }
    }

    loadCachedSales<SaleRecord>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          setSales(cached)
        }
      })
      .catch(error => {
        console.warn('[metrics] Failed to load cached sales', error)
      })

    const q = query(
      collection(db, 'sales'),
      where('storeId', '==', activeStoreId),
      orderBy('createdAt', 'desc'),
      limit(SALES_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(q, snapshot => {
      const rows: SaleRecord[] = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<SaleRecord, 'id'>),
      }))
      setSales(rows)
      saveCachedSales(rows, { storeId: activeStoreId }).catch(error => {
        console.warn('[metrics] Failed to cache sales', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId])

  useEffect(() => {
    let cancelled = false

    if (!activeStoreId) {
      setProducts([])
      return () => {
        cancelled = true
      }
    }

    loadCachedProducts<ProductRecord>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          setProducts(cached)
        }
      })
      .catch(error => {
        console.warn('[metrics] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', activeStoreId),
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
      saveCachedProducts(rows, { storeId: activeStoreId }).catch(error => {
        console.warn('[metrics] Failed to cache products', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId])

  useEffect(() => {
    let cancelled = false

    if (!activeStoreId) {
      setCustomers([])
      return () => {
        cancelled = true
      }
    }

    loadCachedCustomers<CustomerRecord>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          setCustomers(cached)
        }
      })
      .catch(error => {
        console.warn('[metrics] Failed to load cached customers', error)
      })

    const q = query(
      collection(db, 'customers'),
      where('storeId', '==', activeStoreId),
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
      saveCachedCustomers(rows, { storeId: activeStoreId }).catch(error => {
        console.warn('[metrics] Failed to cache customers', error)
      })
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId])

  useEffect(() => {
    if (!activeStoreId) {
      setMonthlyGoals({})
      return () => {}
    }

    const ref = doc(db, 'storeGoals', goalDocumentId)
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
  }, [activeStoreId, goalDocumentId])

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
      end: endOfDay(today),
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
    [sales, rangeStart, rangeEnd],
  )

  const previousSales = useMemo(
    () =>
      sales.filter(record => {
        const created = asDate(record.createdAt)
        return created ? created >= previousRangeStart && created <= previousRangeEnd : false
      }),
    [sales, previousRangeStart, previousRangeEnd],
  )

  const currentRevenue = useMemo(
    () => currentSales.reduce((sum, sale) => sum + (sale.total ?? 0), 0),
    [currentSales],
  )
  const previousRevenue = useMemo(
    () => previousSales.reduce((sum, sale) => sum + (sale.total ?? 0), 0),
    [previousSales],
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
    .filter(Boolean) as InventoryAlert[]

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
    [currentSales, rangeStart, rangeEnd],
  )
  const previousRevenueSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'revenue'),
    [previousSales, previousRangeStart, previousRangeEnd],
  )
  const ticketSeries = useMemo(
    () => buildDailyMetricSeries(currentSales, rangeStart, rangeEnd, 'ticket'),
    [currentSales, rangeStart, rangeEnd],
  )
  const previousTicketSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'ticket'),
    [previousSales, previousRangeStart, previousRangeEnd],
  )
  const salesCountSeries = useMemo(
    () => buildDailyMetricSeries(currentSales, rangeStart, rangeEnd, 'count'),
    [currentSales, rangeStart, rangeEnd],
  )
  const previousSalesCountSeries = useMemo(
    () => buildDailyMetricSeries(previousSales, previousRangeStart, previousRangeEnd, 'count'),
    [previousSales, previousRangeStart, previousRangeEnd],
  )

  const metrics: MetricCard[] = [
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
    [goalMonthDate],
  )

  const goalMonthRevenue = useMemo(
    () =>
      sales.reduce((sum, sale) => {
        const created = asDate(sale.createdAt)
        if (!created || created < goalMonthStart || created > goalMonthEnd) return sum
        return sum + (sale.total ?? 0)
      }, 0),
    [sales, goalMonthStart, goalMonthEnd],
  )

  const goalMonthCustomers = useMemo(
    () =>
      customers.reduce((count, customer) => {
        const created = asDate(customer.createdAt)
        if (!created || created < goalMonthStart || created > goalMonthEnd) return count
        return count + 1
      }, 0),
    [customers, goalMonthStart, goalMonthEnd],
  )

  const activeTargets = useMemo(() => {
    const entry = monthlyGoals[selectedGoalMonth]
    return {
      revenueTarget: entry?.revenueTarget ?? DEFAULT_REVENUE_TARGET,
      customerTarget: entry?.customerTarget ?? DEFAULT_CUSTOMER_TARGET,
    }
  }, [monthlyGoals, selectedGoalMonth])

  const goals: GoalProgress[] = [
    {
      title: `${goalMonthLabel} revenue`,
      value: formatAmount(goalMonthRevenue),
      target: `Goal ${formatAmount(activeTargets.revenueTarget)}`,
      progress: Math.min(
        1,
        activeTargets.revenueTarget ? goalMonthRevenue / activeTargets.revenueTarget : 0,
      ),
    },
    {
      title: `${goalMonthLabel} new customers`,
      value: `${goalMonthCustomers}`,
      target: `Goal ${activeTargets.customerTarget}`,
      progress: Math.min(
        1,
        activeTargets.customerTarget ? goalMonthCustomers / activeTargets.customerTarget : 0,
      ),
    },
  ]

  const rangeSummary = useMemo(() => formatDateRange(rangeStart, rangeEnd), [rangeStart, rangeEnd])
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

  function handleGoalInputChange(field: keyof GoalFormValues, value: string) {
    setGoalFormTouched(true)
    setGoalFormValues(current => ({ ...current, [field]: value }))
  }

  async function handleGoalSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!activeStoreId) {
      publish({ tone: 'error', message: 'Select a store to save goals.' })
      return
    }

    setIsSavingGoals(true)
    try {
      const revenueValue = Number(goalFormValues.revenueTarget)
      const customerValue = Number(goalFormValues.customerTarget)
      const revenueTarget = Number.isFinite(revenueValue) ? Math.max(0, revenueValue) : 0
      const customerTarget = Number.isFinite(customerValue) ? Math.max(0, customerValue) : 0
      const monthKey = selectedGoalMonth || defaultMonthKey

      await setDoc(
        doc(db, 'storeGoals', goalDocumentId),
        {
          monthly: {
            [monthKey]: {
              revenueTarget,
              customerTarget,
            },
          },
        },
        { merge: true },
      )

      setGoalFormTouched(false)
      setGoalFormValues({
        revenueTarget: String(revenueTarget),
        customerTarget: String(customerTarget),
      })
      publish({ tone: 'success', message: `Goals updated for ${goalMonthLabel}.` })
    } catch (error) {
      console.error('[metrics] Unable to save goals', error)
      publish({ tone: 'error', message: 'Unable to save goals right now.' })
    } finally {
      setIsSavingGoals(false)
    }
  }

  const inventoryAlerts = lowStock.slice(0, 5)

  const teamCallouts: TeamCallout[] = [
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

  return {
    rangePresets: RANGE_PRESETS,
    selectedRangeId,
    resolvedRangeId,
    customRange,
    handleRangePresetChange,
    handleCustomDateChange,
    rangeSummary,
    rangeDaysLabel,
    showCustomHint,
    metrics,
    goals,
    goalMonthLabel,
    selectedGoalMonth,
    handleGoalMonthChange,
    goalFormValues,
    handleGoalInputChange,
    handleGoalSubmit,
    isSavingGoals,
    inventoryAlerts,
    teamCallouts,
  }
}

export type {
  MetricCard,
  GoalProgress,
  InventoryAlert,
  TeamCallout,
  PresetRangeId,
  CustomRange,
  RangePreset,
}

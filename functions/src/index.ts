import * as functions from 'firebase-functions'
import { applyRoleClaims } from './customClaims'
import { admin, defaultDb, rosterDb } from './firestore'
import { fetchClientRowByEmail, getDefaultSpreadsheetId, normalizeHeader } from './googleSheets'
import { deriveStoreIdFromContext, withCallableErrorLogging } from './telemetry'

import { FIREBASE_CALLABLES } from '../../shared/firebaseCallables'
import { formatDailySummaryKey, normalizeDailySummaryKey } from '../../shared/dateKeys'


const db = defaultDb

const storeTimezoneCache = new Map<string, string>()

function normalizeTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function getStoreTimezone(storeId: string): Promise<string> {
  if (!storeId) return 'UTC'
  const cached = storeTimezoneCache.get(storeId)
  if (cached) return cached
  try {
    const snapshot = await db.collection('stores').doc(storeId).get()
    if (snapshot.exists) {
      const timezoneValue = normalizeTimezone(snapshot.get('timezone'))
      if (timezoneValue) {
        storeTimezoneCache.set(storeId, timezoneValue)
        return timezoneValue
      }
    }
  } catch (error) {
    functions.logger.error('[dailySummaries] Failed to load store timezone', { storeId, error })
  }
  storeTimezoneCache.set(storeId, 'UTC')
  return 'UTC'
}

function parseTimestampValue(value: unknown): admin.firestore.Timestamp | null {
  if (value instanceof admin.firestore.Timestamp) {
    return value
  }
  if (value instanceof Date) {
    return admin.firestore.Timestamp.fromMillis(value.getTime())
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record._millis === 'number') {
      return admin.firestore.Timestamp.fromMillis(record._millis)
    }
    const secondsValue =
      typeof record._seconds === 'number'
        ? record._seconds
        : typeof record.seconds === 'number'
          ? record.seconds
          : null
    if (secondsValue !== null) {
      const nanosValue =
        typeof record._nanoseconds === 'number'
          ? record._nanoseconds
          : typeof record.nanoseconds === 'number'
            ? record.nanoseconds
            : 0
      const millis = secondsValue * 1000 + nanosValue / 1_000_000
      return admin.firestore.Timestamp.fromMillis(millis)
    }
  }
  return parseDateValue(value)
}

function parseEventTimestamp(eventTimestamp: string | undefined): admin.firestore.Timestamp {
  if (eventTimestamp) {
    const parsed = Date.parse(eventTimestamp)
    if (!Number.isNaN(parsed)) {
      return admin.firestore.Timestamp.fromMillis(parsed)
    }
  }
  return admin.firestore.Timestamp.now()
}

async function resolveStoreDateKey(
  storeId: string,
  sourceTimestamp: unknown,
  eventTimestamp: string | undefined,
): Promise<{ dateKey: string; timestamp: admin.firestore.Timestamp }> {
  const timezone = await getStoreTimezone(storeId)
  const resolvedTimestamp = parseTimestampValue(sourceTimestamp) ?? parseEventTimestamp(eventTimestamp)
  const date = resolvedTimestamp.toDate()
  const dateKey = formatDailySummaryKey(date, {
    timeZone: timezone,
    onInvalidTimeZone: (timeZone, error) => {
      functions.logger.warn('[dailySummaries] Invalid timezone', { timeZone, error })
    },
  })
  return { dateKey, timestamp: resolvedTimestamp }
}

function safeFormatDailySummaryKey(date: Date, timeZone: string): string {
  return formatDailySummaryKey(date, {
    timeZone,
    onInvalidTimeZone: (invalidTimeZone, error) => {
      functions.logger.warn('[nightlyDataHygiene] Invalid timezone for date formatting', {
        timeZone: invalidTimeZone,
        error,
      })
    },
  })
}

function getMillisForZonedDate(timeZone: string, year: number, month: number, day: number): number {
  const baseMillis = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  const baseDate = new Date(baseMillis)

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })

    const parts = formatter.formatToParts(baseDate)
    const getPart = (type: string, fallback: number): number => {
      const part = parts.find(entry => entry.type === type)
      if (!part) return fallback
      const parsed = Number(part.value)
      return Number.isFinite(parsed) ? parsed : fallback
    }

    const resolvedYear = getPart('year', year)
    const resolvedMonth = getPart('month', month)
    const resolvedDay = getPart('day', day)
    const resolvedHour = getPart('hour', 0)
    const resolvedMinute = getPart('minute', 0)
    const resolvedSecond = getPart('second', 0)

    if (
      [resolvedYear, resolvedMonth, resolvedDay, resolvedHour, resolvedMinute, resolvedSecond].some(value =>
        Number.isNaN(value),
      )
    ) {
      return baseMillis
    }

    const zonedMillis = Date.UTC(
      resolvedYear,
      resolvedMonth - 1,
      resolvedDay,
      resolvedHour,
      resolvedMinute,
      resolvedSecond,
    )
    const diff = zonedMillis - baseMillis
    return baseMillis - diff
  } catch (error) {
    functions.logger.warn('[nightlyDataHygiene] Failed to resolve zoned date', { timeZone, error })
    return baseMillis
  }
}

function computePreviousDayWindow(
  timeZone: string,
  reference: Date,
): { start: Date; end: Date; dateKey: string; timeZone: string } {
  const normalizedTimeZone = timeZone || 'UTC'
  let effectiveTimeZone = normalizedTimeZone
  let formatter: Intl.DateTimeFormat

  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch (error) {
    functions.logger.warn('[nightlyDataHygiene] Falling back to UTC for invalid timezone', {
      timeZone: effectiveTimeZone,
      error,
    })
    effectiveTimeZone = 'UTC'
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  const parts = formatter.formatToParts(reference)
  const getPart = (type: string, fallback: number): number => {
    const part = parts.find(entry => entry.type === type)
    if (!part) return fallback
    const parsed = Number(part.value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const currentYear = getPart('year', reference.getUTCFullYear())
  const currentMonth = getPart('month', reference.getUTCMonth() + 1)
  const currentDay = getPart('day', reference.getUTCDate())

  const currentStartMillis = getMillisForZonedDate(effectiveTimeZone, currentYear, currentMonth, currentDay)
  const previousDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay))
  previousDate.setUTCDate(previousDate.getUTCDate() - 1)

  const previousStartMillis = getMillisForZonedDate(
    effectiveTimeZone,
    previousDate.getUTCFullYear(),
    previousDate.getUTCMonth() + 1,
    previousDate.getUTCDate(),
  )

  const start = new Date(previousStartMillis)
  const end = new Date(currentStartMillis)
  const dateKey = safeFormatDailySummaryKey(start, effectiveTimeZone)

  return { start, end, dateKey, timeZone: effectiveTimeZone }
}

type ProductStatIncrement = {
  productId: string
  units: number
  revenue: number
  name?: string | null
}

type DailySummaryUpdateOptions = {
  increments?: Record<string, number>
  lastActivityAt?: admin.firestore.Timestamp
  productStats?: ProductStatIncrement[]
}

async function upsertDailySummaryDoc(
  storeId: string,
  dateKey: string,
  options: DailySummaryUpdateOptions,
): Promise<void> {
  const summaryRef = db.collection('dailySummaries').doc(`${storeId}_${dateKey}`)
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(summaryRef)
    const timestamp = admin.firestore.FieldValue.serverTimestamp()
    const payload: admin.firestore.DocumentData = {
      storeId,
      dateKey,
      updatedAt: timestamp,
    }

    if (options.lastActivityAt) {
      payload.lastActivityAt = options.lastActivityAt
    }

    for (const [field, amount] of Object.entries(options.increments ?? {})) {
      if (!Number.isFinite(amount) || amount === 0) continue
      payload[field] = admin.firestore.FieldValue.increment(amount)
    }

    const productStatsUpdates = new Map<string, { units: number; revenue: number; name?: string }>()
    for (const item of options.productStats ?? []) {
      if (!item || typeof item !== 'object') continue
      const productId = typeof item.productId === 'string' ? item.productId.trim() : ''
      if (!productId) continue

      const units = Number(item.units)
      const revenue = Number(item.revenue)
      if (!Number.isFinite(units) && !Number.isFinite(revenue)) continue

      const normalizedUnits = Number.isFinite(units) ? units : 0
      const normalizedRevenue = Number.isFinite(revenue) ? revenue : 0
      if (normalizedUnits === 0 && normalizedRevenue === 0) continue

      const nameValue = typeof item.name === 'string' ? item.name.trim() : ''
      const existing = productStatsUpdates.get(productId) ?? { units: 0, revenue: 0, name: undefined }
      existing.units += normalizedUnits
      existing.revenue += normalizedRevenue
      if (!existing.name && nameValue) {
        existing.name = nameValue
      }
      productStatsUpdates.set(productId, existing)
    }

    if (productStatsUpdates.size > 0) {
      const existingStatsRaw = snapshot.get('productStats')
      const existingStats = new Map<string, { units: number; revenue: number; name?: string }>()

      if (existingStatsRaw && typeof existingStatsRaw === 'object') {
        for (const [productId, value] of Object.entries(existingStatsRaw as Record<string, unknown>)) {
          if (!value || typeof value !== 'object') continue
          const record = value as Record<string, unknown>
          const units = Number(record.units)
          const revenue = Number(record.revenue)
          const existingName = typeof record.name === 'string' ? record.name : undefined
          existingStats.set(productId, {
            units: Number.isFinite(units) ? units : 0,
            revenue: Number.isFinite(revenue) ? revenue : 0,
            name: existingName,
          })
        }
      }

      for (const [productId, update] of productStatsUpdates.entries()) {
        const entry = existingStats.get(productId) ?? { units: 0, revenue: 0, name: undefined }
        entry.units += update.units
        entry.revenue += update.revenue
        if (update.name) {
          entry.name = update.name
        }
        existingStats.set(productId, entry)
      }

      const sortedStats = [...existingStats.entries()]
        .filter(([, value]) => value.units > 0 || value.revenue > 0)
        .sort((a, b) => {
          if (b[1].units !== a[1].units) return b[1].units - a[1].units
          if (b[1].revenue !== a[1].revenue) return b[1].revenue - a[1].revenue
          return a[0].localeCompare(b[0])
        })

      const topStats = sortedStats.slice(0, 5)
      const topIds = new Set(topStats.map(([productId]) => productId))
      payload.productStatsOrder = topStats.map(([productId]) => productId)

      const entryPayloads: Record<string, admin.firestore.DocumentData> = {}
      for (const [productId, stat] of topStats) {
        const update = productStatsUpdates.get(productId)
        const unitsIncrement = update?.units ?? 0
        const revenueIncrement = update?.revenue ?? 0
        entryPayloads[productId] = {
          name: stat.name ?? null,
          units: admin.firestore.FieldValue.increment(unitsIncrement),
          revenue: admin.firestore.FieldValue.increment(revenueIncrement),
        }
      }

      for (const [productId, entry] of Object.entries(entryPayloads)) {
        payload[`productStats.${productId}`] = entry
      }

      if (existingStatsRaw && typeof existingStatsRaw === 'object') {
        for (const productId of Object.keys(existingStatsRaw as Record<string, unknown>)) {
          if (!topIds.has(productId)) {
            payload[`productStats.${productId}`] = admin.firestore.FieldValue.delete()
          }
        }
      }
    }

    if (!snapshot.exists) {
      payload.createdAt = timestamp
    }

    tx.set(summaryRef, payload, { merge: true })
  })
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

function sanitizeRefs(input: Record<string, unknown>): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) refs[key] = trimmed
    }
  }
  return refs
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function normalizePaymentMethod(method: string): string {
  const normalized = method.trim().toLowerCase()
  if (!normalized) return 'unknown method'
  if (normalized === 'cash') return 'cash'
  if (normalized === 'card') return 'card'
  if (normalized === 'mobile') return 'mobile'
  return normalized
}

type TenderStats = {
  methods: string[]
  cardTotal: number
  cashTotal: number
}

function collectTenderStats(tenders: unknown): TenderStats {
  const stats: TenderStats = { methods: [], cardTotal: 0, cashTotal: 0 }
  if (!tenders || typeof tenders !== 'object') {
    return stats
  }

  const methodLabels = new Set<string>()
  for (const [key, value] of Object.entries(tenders as Record<string, unknown>)) {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount <= 0) {
      continue
    }

    const methodKey = String(key)
    const normalizedKey = methodKey.trim().toLowerCase()
    const label = normalizePaymentMethod(methodKey)
    if (!methodLabels.has(label)) {
      methodLabels.add(label)
      stats.methods.push(label)
    }

    if (normalizedKey === 'cash') {
      stats.cashTotal += amount
    } else if (normalizedKey === 'card' || normalizedKey === 'mobile') {
      stats.cardTotal += amount
    }
  }

  return stats
}

function formatSaleSummary(total: number, methods: string[]): string {
  const labels = methods.length ? methods : ['unknown method']
  const unique = Array.from(new Set(labels))
  const summaryLabel = unique.length === 1
    ? unique[0]
    : `${unique.slice(0, -1).join(', ')} & ${unique.slice(-1)}`
  if (total > 0) {
    return `Recorded sale of ${formatAmount(total)} via ${summaryLabel}`
  }
  return `Recorded sale via ${summaryLabel}`
}

function formatReceiptSummary(qty: number, productId: string | null, totalCost: number): string {
  const quantityLabel = qty === 1 ? '1 unit' : `${qty} units`
  const productLabel = productId ? ` for ${productId}` : ''
  const costLabel = totalCost > 0 ? ` totaling ${formatAmount(totalCost)}` : ''
  return `Received ${quantityLabel}${productLabel}${costLabel}`
}

function formatCustomerSummary(name: string | null): string {
  return name ? `Added new customer ${name}` : 'Added new customer'
}

function formatCloseoutSummary(countedCash: number, variance: number): string {
  let varianceSummary = 'matched expected totals'
  if (variance > 0) {
    varianceSummary = `over by ${formatAmount(variance)}`
  } else if (variance < 0) {
    varianceSummary = `short by ${formatAmount(Math.abs(variance))}`
  }
  return `Closed day with counted cash of ${formatAmount(countedCash)} (${varianceSummary})`
}

async function recordActivityEntry(activity: {
  storeId: string
  dateKey: string
  at: admin.firestore.Timestamp
  type: string
  summary: string
  refs: Record<string, unknown>
}): Promise<void> {
  const activityRef = db.collection('activities').doc()
  await activityRef.set({
    storeId: activity.storeId,
    dateKey: activity.dateKey,
    at: activity.at,
    type: activity.type,
    summary: activity.summary,
    refs: sanitizeRefs(activity.refs),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

type RolledSummaryTotals = {
  salesCount: number
  salesTotal: number
  cardTotal: number
  cashTotal: number
  receiptsCount: number
  unitsReceived: number
  receiptCostTotal: number
  newCustomersCount: number
  closeoutsCount: number
  closeoutCountedTotal: number
  closeoutExpectedTotal: number
  closeoutVarianceTotal: number
}

const ROLLED_SUMMARY_FIELDS: (keyof RolledSummaryTotals)[] = [
  'salesCount',
  'salesTotal',
  'cardTotal',
  'cashTotal',
  'receiptsCount',
  'unitsReceived',
  'receiptCostTotal',
  'newCustomersCount',
  'closeoutsCount',
  'closeoutCountedTotal',
  'closeoutExpectedTotal',
  'closeoutVarianceTotal',
]

function getTimestampMillis(value: unknown): number | null {
  const timestamp = parseTimestampValue(value)
  return timestamp ? timestamp.toMillis() : null
}

async function recomputeDailySummaryForStore(storeId: string, referenceDate: Date): Promise<void> {
  const timezone = await getStoreTimezone(storeId)
  const window = computePreviousDayWindow(timezone, referenceDate)
  const startMillis = window.start.getTime()
  const endMillis = window.end.getTime()
  const startTimestamp = admin.firestore.Timestamp.fromMillis(startMillis)
  const endTimestamp = admin.firestore.Timestamp.fromMillis(endMillis)

  const [salesSnapshot, receiptsSnapshot, customersSnapshot, closeoutsSnapshot] = await Promise.all([
    db
      .collection('sales')
      .where('storeId', '==', storeId)
      .where('createdAt', '>=', startTimestamp)
      .where('createdAt', '<', endTimestamp)
      .get(),
    db
      .collection('receipts')
      .where('storeId', '==', storeId)
      .where('createdAt', '>=', startTimestamp)
      .where('createdAt', '<', endTimestamp)
      .get(),
    db
      .collection('customers')
      .where('storeId', '==', storeId)
      .where('createdAt', '>=', startTimestamp)
      .where('createdAt', '<', endTimestamp)
      .get(),
    db.collection('closeouts').where('storeId', '==', storeId).get(),
  ])

  const totals: RolledSummaryTotals = {
    salesCount: 0,
    salesTotal: 0,
    cardTotal: 0,
    cashTotal: 0,
    receiptsCount: 0,
    unitsReceived: 0,
    receiptCostTotal: 0,
    newCustomersCount: 0,
    closeoutsCount: 0,
    closeoutCountedTotal: 0,
    closeoutExpectedTotal: 0,
    closeoutVarianceTotal: 0,
  }

  let latestActivityMillis: number | null = null
  const updateLatest = (candidate: number | null) => {
    if (candidate === null || Number.isNaN(candidate)) {
      return
    }
    if (latestActivityMillis === null || candidate > latestActivityMillis) {
      latestActivityMillis = candidate
    }
  }

  for (const doc of salesSnapshot.docs) {
    const data = doc.data() as Record<string, unknown>
    const createdAtMillis = getTimestampMillis(data.createdAt)
    if (createdAtMillis === null || createdAtMillis < startMillis || createdAtMillis >= endMillis) {
      continue
    }

    const saleTotal = Math.max(0, coerceNumber(data.total))
    const tenderStats = collectTenderStats(data.tenders)
    let cardIncrement = tenderStats.cardTotal
    let cashIncrement = tenderStats.cashTotal

    if (tenderStats.methods.length === 0) {
      const legacyPayment = (data.payment ?? {}) as Record<string, unknown>
      const paymentMethod = typeof legacyPayment.method === 'string' ? legacyPayment.method : ''
      const normalizedMethod = paymentMethod.trim().toLowerCase()
      if (normalizedMethod === 'cash') {
        cashIncrement = saleTotal
      } else if (normalizedMethod === 'card' || normalizedMethod === 'mobile') {
        cardIncrement = saleTotal
      }
    }

    totals.salesCount += 1
    totals.salesTotal += saleTotal
    if (cardIncrement !== 0) {
      totals.cardTotal += cardIncrement
    }
    if (cashIncrement !== 0) {
      totals.cashTotal += cashIncrement
    }
    updateLatest(createdAtMillis)
  }

  for (const doc of receiptsSnapshot.docs) {
    const data = doc.data() as Record<string, unknown>
    const createdAtMillis = getTimestampMillis(data.createdAt)
    if (createdAtMillis === null || createdAtMillis < startMillis || createdAtMillis >= endMillis) {
      continue
    }

    const unitsReceived = Math.max(0, coerceNumber(data.qty))
    const receiptCostTotal = Math.max(0, coerceNumber(data.totalCost))

    totals.receiptsCount += 1
    if (unitsReceived !== 0) {
      totals.unitsReceived += unitsReceived
    }
    if (receiptCostTotal !== 0) {
      totals.receiptCostTotal += receiptCostTotal
    }
    updateLatest(createdAtMillis)
  }

  for (const doc of customersSnapshot.docs) {
    const data = doc.data() as Record<string, unknown>
    const createdAtMillis = getTimestampMillis(data.createdAt)
    if (createdAtMillis === null || createdAtMillis < startMillis || createdAtMillis >= endMillis) {
      continue
    }

    totals.newCustomersCount += 1
    updateLatest(createdAtMillis)
  }

  for (const doc of closeoutsSnapshot.docs) {
    const data = doc.data() as Record<string, unknown>
    const sourceMillis =
      getTimestampMillis(data.closedAt) ?? getTimestampMillis(data.createdAt) ?? null
    if (sourceMillis === null || sourceMillis < startMillis || sourceMillis >= endMillis) {
      continue
    }

    const countedCash = coerceNumber(data.countedCash)
    const expectedCash = coerceNumber(data.expectedCash)
    const hasVarianceField = Object.prototype.hasOwnProperty.call(data, 'variance')
    const varianceValue = hasVarianceField ? coerceNumber(data.variance) : countedCash - expectedCash

    totals.closeoutsCount += 1
    if (countedCash !== 0) {
      totals.closeoutCountedTotal += countedCash
    }
    if (expectedCash !== 0) {
      totals.closeoutExpectedTotal += expectedCash
    }
    if (varianceValue !== 0) {
      totals.closeoutVarianceTotal += varianceValue
    }
    updateLatest(sourceMillis)
  }

  const summaryRef = db.collection('dailySummaries').doc(`${storeId}_${window.dateKey}`)
  const summarySnapshot = await summaryRef.get()
  const existingData = (summarySnapshot.data() ?? {}) as Record<string, unknown>
  const increments: Record<string, number> = {}

  for (const field of ROLLED_SUMMARY_FIELDS) {
    const target = totals[field]
    const previous = coerceNumber(existingData[field])
    const delta = target - previous
    if (delta !== 0) {
      increments[field] = delta
    }
  }

  let lastActivityAt: admin.firestore.Timestamp | undefined
  if (latestActivityMillis !== null) {
    const existingLastActivityMillis = getTimestampMillis(existingData.lastActivityAt)
    if (existingLastActivityMillis === null || existingLastActivityMillis !== latestActivityMillis) {
      lastActivityAt = admin.firestore.Timestamp.fromMillis(latestActivityMillis)
    }
  }

  await upsertDailySummaryDoc(storeId, window.dateKey, {
    increments,
    lastActivityAt,
  })
}

async function cleanActivityDocuments(): Promise<void> {
  const snapshot = await db.collection('activities').get()
  for (const doc of snapshot.docs) {
    const data = doc.data() as Record<string, unknown>
    const storeIdRaw = data.storeId
    const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
    if (!storeId) {
      await doc.ref.delete()
      continue
    }

    const existingDateKeyRaw = typeof data.dateKey === 'string' ? data.dateKey.trim() : ''
    const normalizedDateKey = existingDateKeyRaw ? normalizeDailySummaryKey(existingDateKeyRaw) : null

    let needsUpdate = false
    let nextDateKey = normalizedDateKey ?? existingDateKeyRaw

    if (!normalizedDateKey) {
      const timestampSource = (data.at ?? data.createdAt ?? data.updatedAt) as unknown
      if (timestampSource == null) {
        continue
      }
      const { dateKey } = await resolveStoreDateKey(storeId, timestampSource, undefined)
      nextDateKey = dateKey
      needsUpdate = true
    } else if (normalizedDateKey !== existingDateKeyRaw) {
      needsUpdate = true
    }

    if (needsUpdate && nextDateKey) {
      await doc.ref.update({ dateKey: nextDateKey })
    }
  }
}

type ContactPayload = {
  phone?: unknown
  phoneCountryCode?: unknown
  phoneLocalNumber?: unknown
  firstSignupEmail?: unknown
  company?: unknown
  ownerName?: unknown
}

type InitializeStorePayload = {
  contact?: ContactPayload
  storeId?: unknown
}

type ManageStaffPayload = {
  storeId?: unknown
  email?: unknown
  role?: unknown
  password?: unknown
}

type UpdateStoreProfilePayload = {
  storeId?: unknown
  name?: unknown
  timezone?: unknown
  currency?: unknown
}

type RevokeStaffAccessPayload = {
  storeId?: unknown
  uid?: unknown
}

const VALID_ROLES = new Set(['owner', 'staff'])
const INACTIVE_WORKSPACE_MESSAGE =
  'Your Sedifex workspace contract is not active. Reach out to your Sedifex administrator to restore access.'

function normalizeContactPayload(contact: ContactPayload | undefined) {
  let hasPhone = false
  let hasPhoneCountryCode = false
  let hasPhoneLocalNumber = false
  let hasFirstSignupEmail = false
  let hasCompany = false
  let hasOwnerName = false
  let phone: string | null | undefined
  let phoneCountryCode: string | null | undefined
  let phoneLocalNumber: string | null | undefined
  let firstSignupEmail: string | null | undefined
  let company: string | null | undefined
  let ownerName: string | null | undefined

  if (contact && typeof contact === 'object') {
    if ('phone' in contact) {
      hasPhone = true
      const raw = contact.phone
      if (raw === null || raw === undefined || raw === '') {
        phone = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        phone = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError('invalid-argument', 'Phone must be a string when provided')
      }
    }

    if ('phoneCountryCode' in contact) {
      hasPhoneCountryCode = true
      const raw = (contact as Record<string, unknown>).phoneCountryCode
      if (raw === null || raw === undefined || raw === '') {
        phoneCountryCode = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        phoneCountryCode = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Phone country code must be a string when provided',
        )
      }
    }

    if ('phoneLocalNumber' in contact) {
      hasPhoneLocalNumber = true
      const raw = (contact as Record<string, unknown>).phoneLocalNumber
      if (raw === null || raw === undefined || raw === '') {
        phoneLocalNumber = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        phoneLocalNumber = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Phone local number must be a string when provided',
        )
      }
    }

    if ('firstSignupEmail' in contact) {
      hasFirstSignupEmail = true
      const raw = contact.firstSignupEmail
      if (raw === null || raw === undefined || raw === '') {
        firstSignupEmail = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim().toLowerCase()
        firstSignupEmail = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'First signup email must be a string when provided',
        )
      }
    }

    if ('company' in contact) {
      hasCompany = true
      const raw = contact.company
      if (raw === null || raw === undefined || raw === '') {
        company = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        company = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError('invalid-argument', 'Company must be a string when provided')
      }
    }

    if ('ownerName' in contact) {
      hasOwnerName = true
      const raw = contact.ownerName
      if (raw === null || raw === undefined || raw === '') {
        ownerName = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        ownerName = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError('invalid-argument', 'Owner name must be a string when provided')
      }
    }
  }

  return {
    phone,
    hasPhone,
    phoneCountryCode,
    hasPhoneCountryCode,
    phoneLocalNumber,
    hasPhoneLocalNumber,
    firstSignupEmail,
    hasFirstSignupEmail,
    company,
    hasCompany,
    ownerName,
    hasOwnerName,
  }
}

function getRoleFromToken(token: Record<string, unknown> | undefined) {
  const role = typeof token?.role === 'string' ? (token.role as string) : null
  return role && VALID_ROLES.has(role) ? role : null
}

function assertAuthenticated(context: functions.https.CallableContext) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required')
  }
}

function assertOwnerAccess(context: functions.https.CallableContext) {
  assertAuthenticated(context)
  const role = getRoleFromToken(context.auth!.token as Record<string, unknown>)
  if (role !== 'owner') {
    throw new functions.https.HttpsError('permission-denied', 'Owner access required')
  }
}

function assertStaffAccess(context: functions.https.CallableContext) {
  assertAuthenticated(context)
  const role = getRoleFromToken(context.auth!.token as Record<string, unknown>)
  if (!role) {
    throw new functions.https.HttpsError('permission-denied', 'Staff access required')
  }
}

function normalizeManageStaffPayload(data: ManageStaffPayload) {
  const storeIdRaw = data.storeId
  const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
  const role = typeof data.role === 'string' ? data.role.trim() : ''
  const passwordRaw = data.password
  let password: string | undefined
  if (passwordRaw === null || passwordRaw === undefined || passwordRaw === '') {
    password = undefined
  } else if (typeof passwordRaw === 'string') {
    password = passwordRaw
  } else {
    throw new functions.https.HttpsError('invalid-argument', 'Password must be a string when provided')
  }

  if (!storeId) throw new functions.https.HttpsError('invalid-argument', 'A storeId is required')
  if (!email) throw new functions.https.HttpsError('invalid-argument', 'A valid email is required')
  if (!role) throw new functions.https.HttpsError('invalid-argument', 'A role is required')
  if (!VALID_ROLES.has(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Unsupported role requested')
  }

  return { storeId, email, role, password }
}

function normalizeUpdateStoreProfilePayload(data: UpdateStoreProfilePayload) {
  const storeId = typeof data.storeId === 'string' ? data.storeId.trim() : ''
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const timezone = typeof data.timezone === 'string' ? data.timezone.trim() : ''
  const currencyRaw = typeof data.currency === 'string' ? data.currency.trim() : ''

  if (!storeId) {
    throw new functions.https.HttpsError('invalid-argument', 'A storeId is required')
  }

  if (!name) {
    throw new functions.https.HttpsError('invalid-argument', 'A workspace name is required')
  }

  if (!timezone) {
    throw new functions.https.HttpsError('invalid-argument', 'A timezone is required')
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
  } catch (error) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter a valid IANA timezone')
  }

  if (!currencyRaw) {
    throw new functions.https.HttpsError('invalid-argument', 'A currency code is required')
  }

  const normalizedCurrency = currencyRaw.toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter a 3-letter currency code')
  }

  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: normalizedCurrency }).format(1)
  } catch (error) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter a supported currency code')
  }

  return { storeId, name, timezone, currency: normalizedCurrency }
}

function normalizeRevokeStaffAccessPayload(data: RevokeStaffAccessPayload) {
  const storeId = typeof data.storeId === 'string' ? data.storeId.trim() : ''
  const uid = typeof data.uid === 'string' ? data.uid.trim() : ''

  if (!storeId) {
    throw new functions.https.HttpsError('invalid-argument', 'A storeId is required')
  }

  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'A user ID is required')
  }

  return { storeId, uid }
}

async function ensureAuthUser(email: string, password?: string) {
  try {
    const record = await admin.auth().getUserByEmail(email)
    if (password) await admin.auth().updateUser(record.uid, { password })
    return { record, created: false }
  } catch (error: any) {
    if (error?.code === 'auth/user-not-found') {
      if (!password) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'A password is required when creating a new staff account',
        )
      }
      const record = await admin.auth().createUser({ email, password, emailVerified: false })
      return { record, created: true }
    }
    throw error
  }
}

type SheetRecord = Record<string, string>

type SeededDocument = {
  id: string
  data: admin.firestore.DocumentData
}

function getOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return null
}

function getOptionalEmail(value: unknown): string | null {
  const candidate = getOptionalString(value)
  return candidate ? candidate.toLowerCase() : null
}

function getValueFromRecord(record: SheetRecord, keys: string[]): string | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const value = record[normalizedKey]
    const resolved = getOptionalString(value)
    if (resolved) return resolved
  }
  return null
}

function getEmailFromRecord(record: SheetRecord, keys: string[]): string | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const value = record[normalizedKey]
    const resolved = getOptionalEmail(value)
    if (resolved) return resolved
  }
  return null
}

function isInactiveContractStatus(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean)
  const tokenSet = new Set(tokens)
  const inactiveTokens = [
    'inactive',
    'terminated',
    'termination',
    'cancelled',
    'canceled',
    'suspended',
    'paused',
    'hold',
    'closed',
    'ended',
    'deactivated',
    'disabled',
  ]
  return inactiveTokens.some(token => tokenSet.has(token))
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const normalized = trimmed.replace(/[^0-9.+-]/g, '')
    if (!normalized) return null
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseDateValue(value: unknown): admin.firestore.Timestamp | null {
  if (value instanceof admin.firestore.Timestamp) {
    return value
  }

  let candidate: number | null = null

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      candidate = parsed
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000_000_000) {
      candidate = value
    } else if (value > 1_000_000_000) {
      candidate = value * 1000
    } else if (value > 0) {
      const serialEpoch = Date.UTC(1899, 11, 30)
      candidate = serialEpoch + value * 24 * 60 * 60 * 1000
    }
  }

  if (candidate === null) {
    return null
  }

  return admin.firestore.Timestamp.fromMillis(candidate)
}

function getTimestampFromRecord(
  record: SheetRecord,
  keys: string[],
): admin.firestore.Timestamp | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const raw = record[normalizedKey]
    const parsed = parseDateValue(raw)
    if (parsed) return parsed
  }
  return null
}

function getNumberFromRecord(record: SheetRecord, keys: string[]): number | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const raw = record[normalizedKey]
    const parsed = parseNumberValue(raw)
    if (parsed !== null) return parsed
  }
  return null
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildSeedId(storeId: string, candidate: string | null, fallback: string): string {
  const normalizedCandidate = candidate ? slugify(candidate) : ''
  if (normalizedCandidate) {
    return `${storeId}_${normalizedCandidate}`
  }
  return `${storeId}_${fallback}`
}

function parseSeedArray(record: SheetRecord, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = getOptionalString(record[key])
    if (!value) continue
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter(item => typeof item === 'object' && item !== null) as Record<string, unknown>[]
      }
      if (parsed && typeof parsed === 'object') {
        return Object.values(parsed as Record<string, unknown>).filter(
          item => typeof item === 'object' && item !== null,
        ) as Record<string, unknown>[]
      }
    } catch (error) {
      functions.logger.warn('[resolveStoreAccess] Unable to parse seed data column', key, error)
    }
  }
  return []
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => getOptionalString(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
  }
  const asString = getOptionalString(value)
  if (!asString) return []
  return asString
    .split(/[,#]/)
    .map(part => part.trim())
    .filter(Boolean)
}

function mapProductSeeds(record: SheetRecord, storeId: string): SeededDocument[] {
  const products = parseSeedArray(record, ['products_json', 'products'])
  return products
    .map((product, index) => {
      const name = getOptionalString(product.name ?? product.product_name ?? product.title)
      if (!name) return null
      const sku = getOptionalString(product.sku ?? product.product_sku ?? product.code)
      const idCandidate =
        getOptionalString(product.id ?? product.product_id ?? product.identifier ?? sku ?? name) ?? null
      const price =
        parseNumberValue(product.price ?? product.unit_price ?? product.retail_price ?? product.cost_price) ?? null
      const stockCount =
        parseNumberValue(product.stockCount ?? product.stock_count ?? product.quantity ?? product.inventory) ?? null
      const reorderThreshold =
        parseNumberValue(
          product.reorderThreshold ?? product.reorder_threshold ?? product.reorder_point ?? product.reorder,
        ) ?? null

      const seedId = buildSeedId(storeId, idCandidate, `product_${index + 1}`)
      const data: admin.firestore.DocumentData = { storeId, name }
      if (sku) data.sku = sku
      if (price !== null) data.price = price
      if (stockCount !== null) data.stockCount = stockCount
      if (reorderThreshold !== null) data.reorderThreshold = reorderThreshold
      return { id: seedId, data }
    })
    .filter((item): item is SeededDocument => item !== null)
}

function mapCustomerSeeds(record: SheetRecord, storeId: string): SeededDocument[] {
  const customers = parseSeedArray(record, ['customers_json', 'customers'])
  return customers
    .map((customer, index) => {
      const primaryName =
        getOptionalString(customer.displayName ?? customer.display_name ?? customer.name ?? customer.customer_name) ??
        null
      const fallbackName =
        getOptionalString(customer.name ?? customer.customer_name ?? customer.displayName ?? customer.display_name) ??
        primaryName
      const email = getOptionalEmail(customer.email ?? customer.contact_email)
      const phone = getOptionalString(customer.phone ?? customer.phone_number ?? customer.contact_phone)

      if (!primaryName && !fallbackName && !email && !phone) {
        return null
      }

      const identifierCandidate =
        getOptionalString(
          customer.id ??
            customer.customer_id ??
            customer.identifier ??
            customer.external_id ??
            email ??
            phone ??
            primaryName ??
            fallbackName ??
            undefined,
        ) ?? null

      const tags = parseTags(customer.tags ?? customer.labels)
      const notes = getOptionalString(customer.notes ?? customer.note ?? customer.summary)

      const seedId = buildSeedId(storeId, identifierCandidate, `customer_${index + 1}`)
      const data: admin.firestore.DocumentData = {
        storeId,
        name: fallbackName ?? primaryName ?? email ?? phone ?? seedId,
      }
      if (primaryName) data.displayName = primaryName
      if (email) data.email = email
      if (phone) data.phone = phone
      if (notes) data.notes = notes
      if (tags.length) data.tags = tags
      return { id: seedId, data }
    })
    .filter((item): item is SeededDocument => item !== null)
}

function serializeFirestoreData(data: admin.firestore.DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof admin.firestore.Timestamp) {
      result[key] = value.toMillis()
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item instanceof admin.firestore.Timestamp ? item.toMillis() : item,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

export const handleUserCreate = functions.auth.user().onCreate(async user => {
  const uid = user.uid
  const timestamp = admin.firestore.FieldValue.serverTimestamp()
  await rosterDb
    .collection('teamMembers')
    .doc(uid)
    .set(
      {
        uid,
        email: user.email ?? null,
        phone: user.phoneNumber ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    )
})

function normalizeStoreId(
  candidate: unknown,
  existingStoreId: string | null,
  fallbackStoreId: string,
): string {
  if (candidate === undefined || candidate === null) {
    return existingStoreId ?? fallbackStoreId
  }

  if (typeof candidate !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Store ID must be a string when provided')
  }

  const trimmed = candidate.trim()
  if (!trimmed) {
    if (existingStoreId) {
      return existingStoreId
    }
    throw new functions.https.HttpsError('invalid-argument', 'A store ID is required')
  }

  if (existingStoreId && existingStoreId !== trimmed) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This account is already assigned to a different store.',
    )
  }

  return trimmed
}

async function handleStoreBootstrap(
  data: InitializeStorePayload,
  context: functions.https.CallableContext,
): Promise<{ ok: true; storeId: string }> {
  assertAuthenticated(context)

  const uid = context.auth!.uid
  const token = context.auth!.token as Record<string, unknown>
  const email = typeof token.email === 'string' ? (token.email as string) : null
  const tokenPhone = typeof token.phone_number === 'string' ? (token.phone_number as string) : null

  const payload = (data ?? {}) as InitializeStorePayload
  const contact = normalizeContactPayload(payload.contact)
  const resolvedPhone = contact.hasPhone ? contact.phone ?? null : tokenPhone ?? null
  const resolvedFirstSignupEmail = contact.hasFirstSignupEmail
    ? contact.firstSignupEmail ?? null
    : email?.toLowerCase() ?? null

  const memberRef = rosterDb.collection('teamMembers').doc(uid)
  const memberSnap = await memberRef.get()
  const timestamp = admin.firestore.FieldValue.serverTimestamp()
  const existingData = memberSnap.data() ?? {}
  const existingMemberCompany =
    typeof existingData.company === 'string' ? (existingData.company as string).trim() : ''
  const existingMemberName =
    typeof existingData.name === 'string' ? (existingData.name as string).trim() : ''
  const existingStoreId =
    typeof existingData.storeId === 'string' && existingData.storeId.trim() !== ''
      ? (existingData.storeId as string)
      : null
  const storeId = normalizeStoreId(payload.storeId, existingStoreId, uid)

  const memberData: admin.firestore.DocumentData = {
    uid,
    email,
    role: 'owner',
    storeId,
    phone: resolvedPhone,
    firstSignupEmail: resolvedFirstSignupEmail,
    invitedBy: uid,
    updatedAt: timestamp,
  }

  if (contact.hasPhoneCountryCode) {
    memberData.phoneCountryCode = contact.phoneCountryCode ?? null
  }

  if (contact.hasPhoneLocalNumber) {
    memberData.phoneLocalNumber = contact.phoneLocalNumber ?? null
  }

  if (contact.hasCompany) {
    memberData.company = contact.company ?? null
  } else if (!memberSnap.exists && existingMemberCompany) {
    memberData.company = existingMemberCompany
  }

  if (contact.hasOwnerName) {
    memberData.name = contact.ownerName ?? null
  } else if (!memberSnap.exists && existingMemberName) {
    memberData.name = existingMemberName
  }

  if (!memberSnap.exists) {
    memberData.createdAt = timestamp
  }

  await memberRef.set(memberData, { merge: true })

  const storeRef = defaultDb.collection('stores').doc(storeId)
  const storeSnap = await storeRef.get()
  const existingStore = storeSnap.data() ?? {}
  const existingStoreCompany =
    typeof existingStore.company === 'string' ? (existingStore.company as string).trim() : ''
  const existingStoreOwnerName =
    typeof existingStore.ownerName === 'string' ? (existingStore.ownerName as string).trim() : ''

  const resolvedCompany = contact.hasCompany
    ? contact.company ?? null
    : existingMemberCompany || existingStoreCompany
    ? (existingMemberCompany || existingStoreCompany)
    : null

  const resolvedOwnerName = contact.hasOwnerName
    ? contact.ownerName ?? null
    : existingMemberName || existingStoreOwnerName
    ? (existingMemberName || existingStoreOwnerName)
    : null

  const storeData: admin.firestore.DocumentData = {
    storeId,
    ownerId: uid,
    updatedAt: timestamp,
  }

  if (!storeSnap.exists) {
    storeData.createdAt = timestamp
  }

  if (resolvedOwnerName) {
    storeData.ownerName = resolvedOwnerName
  }

  if (resolvedCompany) {
    storeData.company = resolvedCompany
  }

  await storeRef.set(storeData, { merge: true })

  await applyRoleClaims({ uid, role: 'owner', storeId })

  return { ok: true, storeId }
}

export const initializeStore = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.INITIALIZE_STORE,
    async (data, context) => handleStoreBootstrap((data ?? {}) as InitializeStorePayload, context),
    {
      resolveStoreId: (rawData, context) => {
        const payload = (rawData ?? {}) as { storeId?: unknown }
        const candidate = typeof payload.storeId === 'string' ? payload.storeId.trim() : ''
        if (candidate) return candidate
        return deriveStoreIdFromContext(context) ?? context.auth?.uid ?? null
      },
    },
  ),
)

export const afterSignupBootstrap = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.AFTER_SIGNUP_BOOTSTRAP,
    async (data, context) => handleStoreBootstrap((data ?? {}) as InitializeStorePayload, context),
    {
      resolveStoreId: (rawData, context) => {
        const payload = (rawData ?? {}) as { storeId?: unknown }
        const candidate = typeof payload.storeId === 'string' ? payload.storeId.trim() : ''
        if (candidate) return candidate
        return deriveStoreIdFromContext(context) ?? context.auth?.uid ?? null
      },
    },
  ),
)

export const resolveStoreAccess = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.RESOLVE_STORE_ACCESS,
    async (data, context) => {
      assertAuthenticated(context)

      const uid = context.auth!.uid
      const token = context.auth!.token as Record<string, unknown>
      const emailFromToken = typeof token.email === 'string' ? (token.email as string).toLowerCase() : null

  const rawPayload = (data ?? {}) as { storeId?: unknown } | unknown
  let requestedStoreId: string | null = null
  if (typeof rawPayload === 'object' && rawPayload !== null && 'storeId' in rawPayload) {
    const candidate = (rawPayload as { storeId?: unknown }).storeId
    if (typeof candidate !== 'string') {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Enter the store ID assigned to your Sedifex workspace.',
      )
    }
    const trimmed = candidate.trim()
    if (!trimmed) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Enter the store ID assigned to your Sedifex workspace.',
      )
    }
    requestedStoreId = trimmed
  }

  if (!emailFromToken) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'A verified email is required to resolve store access for this account.',
    )
  }

  let sheetRow: Awaited<ReturnType<typeof fetchClientRowByEmail>>
  try {
    sheetRow = await fetchClientRowByEmail(getDefaultSpreadsheetId(), emailFromToken)
  } catch (error) {
    functions.logger.error('[resolveStoreAccess] Failed to query Google Sheets', error)
    throw new functions.https.HttpsError('internal', 'Unable to verify workspace access at this time.')
  }

  if (!sheetRow) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'We could not find a workspace assignment for this account. Reach out to your Sedifex administrator.',
    )
  }

  const record = sheetRow.record
  const now = admin.firestore.Timestamp.now()

  const memberRef = rosterDb.collection('teamMembers').doc(uid)
  const memberSnap = await memberRef.get()
  const existingMember = memberSnap.data() ?? {}

  const existingStoreId =
    typeof existingMember.storeId === 'string' && existingMember.storeId.trim() !== ''
      ? (existingMember.storeId as string).trim()
      : null

  const sheetStoreIdValue = getValueFromRecord(record, [
    'store_id',
    'storeid',
    'store_identifier',
    'store',
  ])
  const normalizedSheetStoreId =
    typeof sheetStoreIdValue === 'string' ? sheetStoreIdValue.trim() : ''

  const missingStoreIdMessage =
    'We could not confirm the store ID assigned to your Sedifex workspace. Reach out to your Sedifex administrator.'

  if (requestedStoreId !== null) {
    if (!normalizedSheetStoreId) {
      throw new functions.https.HttpsError('failed-precondition', missingStoreIdMessage)
    }
    if (requestedStoreId !== normalizedSheetStoreId) {
      throw new functions.https.HttpsError(
        'permission-denied',
        `Your account is assigned to store ${normalizedSheetStoreId}. Enter the correct store ID to continue.`,
      )
    }
  }

  const storeIdCandidate = normalizedSheetStoreId || existingStoreId || null

  if (!storeIdCandidate) {
    throw new functions.https.HttpsError('failed-precondition', missingStoreIdMessage)
  }

  const storeId = storeIdCandidate

  const resolvedRoleCandidate = getValueFromRecord(record, ['role', 'member_role', 'store_role', 'workspace_role'])
  const existingRole =
    typeof existingMember.role === 'string' && VALID_ROLES.has(existingMember.role)
      ? (existingMember.role as 'owner' | 'staff')
      : null
  let resolvedRole: 'owner' | 'staff' = existingRole ?? 'staff'
  if (resolvedRoleCandidate) {
    const normalizedRole = resolvedRoleCandidate.toLowerCase()
    if (normalizedRole.includes('owner')) {
      resolvedRole = 'owner'
    } else if (VALID_ROLES.has(normalizedRole) && existingRole !== 'owner') {
      resolvedRole = normalizedRole as 'owner' | 'staff'
    }
  }

  const memberEmail =
    getEmailFromRecord(record, ['member_email', 'email', 'primary_email', 'user_email']) ?? emailFromToken
  const memberPhone =
    getValueFromRecord(record, ['member_phone', 'phone', 'contact_phone', 'store_contact_phone']) ??
    (typeof existingMember.phone === 'string' ? existingMember.phone : null)
  const firstSignupEmail =
    getEmailFromRecord(record, ['first_signup_email', 'signup_email']) ??
    (typeof existingMember.firstSignupEmail === 'string'
      ? existingMember.firstSignupEmail
      : emailFromToken)
  const memberName =
    getValueFromRecord(record, ['member_name', 'contact_name', 'staff_name', 'name']) ??
    (typeof existingMember.name === 'string' ? existingMember.name : null)
  const invitedBy =
    getValueFromRecord(record, ['invited_by', 'inviter_uid', 'invitedby']) ??
    (typeof existingMember.invitedBy === 'string' ? existingMember.invitedBy : null)

  const memberCreatedAt =
    memberSnap.exists && existingMember.createdAt instanceof admin.firestore.Timestamp
      ? (existingMember.createdAt as admin.firestore.Timestamp)
      : now

  const memberData: admin.firestore.DocumentData = {
    uid,
    storeId,
    role: resolvedRole,
    email: memberEmail,
    updatedAt: now,
    createdAt: memberCreatedAt,
  }
  if (memberPhone) memberData.phone = memberPhone
  if (memberName) memberData.name = memberName
  if (firstSignupEmail) memberData.firstSignupEmail = firstSignupEmail
  if (invitedBy) memberData.invitedBy = invitedBy

  await memberRef.set(memberData, { merge: true })
  const claims = await applyRoleClaims({ uid, role: resolvedRole, storeId })

  const storeRef = defaultDb.collection('stores').doc(storeId)
  const storeSnap = await storeRef.get()
  const existingStore = storeSnap.data() ?? {}
  const storeCreatedAt =
    storeSnap.exists && existingStore.createdAt instanceof admin.firestore.Timestamp
      ? (existingStore.createdAt as admin.firestore.Timestamp)
      : now

  const storeName =
    getValueFromRecord(record, ['store_name', 'workspace_name', 'store']) ??
    (typeof existingStore.name === 'string' ? existingStore.name : null)
  const storeDisplayName =
    getValueFromRecord(record, ['store_display_name', 'display_name']) ??
    (typeof existingStore.displayName === 'string' ? existingStore.displayName : null)
  const storeEmail =
    getEmailFromRecord(record, ['store_email', 'contact_email', 'store_contact_email']) ??
    (typeof existingStore.email === 'string' ? existingStore.email : null)
  const storePhone =
    getValueFromRecord(record, ['store_phone', 'contact_phone', 'store_contact_phone']) ??
    (typeof existingStore.phone === 'string' ? existingStore.phone : null)
  const storeTimezone =
    getValueFromRecord(record, ['store_timezone', 'timezone']) ??
    (typeof existingStore.timezone === 'string' ? existingStore.timezone : null)
  const storeCurrency =
    getValueFromRecord(record, ['store_currency', 'currency']) ??
    (typeof existingStore.currency === 'string' ? existingStore.currency : null)
  const storeStatus =
    getValueFromRecord(record, ['store_status', 'status']) ??
    (typeof existingStore.status === 'string' ? existingStore.status : null)
  const contractStart =
    getTimestampFromRecord(record, [
      'contractStart',
      'contract_start',
      'contract_start_date',
      'contract_start_at',
      'start_date',
    ]) ??
    (existingStore.contractStart instanceof admin.firestore.Timestamp
      ? existingStore.contractStart
      : null)
  const contractEnd =
    getTimestampFromRecord(record, [
      'contractEnd',
      'contract_end',
      'contract_end_date',
      'contract_end_at',
      'end_date',
    ]) ??
    (existingStore.contractEnd instanceof admin.firestore.Timestamp
      ? existingStore.contractEnd
      : null)
  const paymentStatus =
    getValueFromRecord(record, ['paymentStatus', 'payment_status', 'contract_payment_status']) ??
    (typeof existingStore.paymentStatus === 'string' ? existingStore.paymentStatus : null)
  const amountPaid =
    getNumberFromRecord(record, ['amountPaid', 'amount_paid', 'payment_amount', 'contract_amount_paid']) ??
    (typeof existingStore.amountPaid === 'number' && Number.isFinite(existingStore.amountPaid)
      ? (existingStore.amountPaid as number)
      : null)
  const company =
    getValueFromRecord(record, ['company', 'company_name', 'business_name']) ??
    (typeof existingStore.company === 'string' ? existingStore.company : null)

  if (isInactiveContractStatus(storeStatus)) {
    throw new functions.https.HttpsError('permission-denied', INACTIVE_WORKSPACE_MESSAGE)
  }
  const storeAddressLine1 =
    getValueFromRecord(record, ['store_address_line1', 'address_line1', 'address_1']) ??
    (typeof existingStore.addressLine1 === 'string' ? existingStore.addressLine1 : null)
  const storeAddressLine2 =
    getValueFromRecord(record, ['store_address_line2', 'address_line2', 'address_2']) ??
    (typeof existingStore.addressLine2 === 'string' ? existingStore.addressLine2 : null)
  const storeCity =
    getValueFromRecord(record, ['store_city', 'city']) ??
    (typeof existingStore.city === 'string' ? existingStore.city : null)
  const storeRegion =
    getValueFromRecord(record, ['store_region', 'region', 'state', 'province']) ??
    (typeof existingStore.region === 'string' ? existingStore.region : null)
  const storePostalCode =
    getValueFromRecord(record, ['store_postal_code', 'postal_code', 'zip']) ??
    (typeof existingStore.postalCode === 'string' ? existingStore.postalCode : null)
  const storeCountry =
    getValueFromRecord(record, ['store_country', 'country']) ??
    (typeof existingStore.country === 'string' ? existingStore.country : null)

  const storeData: admin.firestore.DocumentData = {
    storeId,
    updatedAt: now,
    createdAt: storeCreatedAt,
  }
  if (storeName) storeData.name = storeName
  if (storeDisplayName) storeData.displayName = storeDisplayName
  if (storeEmail) storeData.email = storeEmail
  if (storePhone) storeData.phone = storePhone
  if (storeTimezone) storeData.timezone = storeTimezone
  if (storeCurrency) storeData.currency = storeCurrency
  if (storeStatus) storeData.status = storeStatus
  if (storeAddressLine1) storeData.addressLine1 = storeAddressLine1
  if (storeAddressLine2) storeData.addressLine2 = storeAddressLine2
  if (storeCity) storeData.city = storeCity
  if (storeRegion) storeData.region = storeRegion
  if (storePostalCode) storeData.postalCode = storePostalCode
  if (storeCountry) storeData.country = storeCountry
  if (contractStart) storeData.contractStart = contractStart
  if (contractEnd) storeData.contractEnd = contractEnd
  if (paymentStatus) storeData.paymentStatus = paymentStatus
  if (amountPaid !== null) storeData.amountPaid = amountPaid
  if (company) storeData.company = company

  await storeRef.set(storeData, { merge: true })

  const productSeeds = mapProductSeeds(record, storeId)
  const customerSeeds = mapCustomerSeeds(record, storeId)

  const productResults = await Promise.all(
    productSeeds.map(async seed => {
      const ref = defaultDb.collection('products').doc(seed.id)
      const snapshot = await ref.get()
      const existingProduct = snapshot.data() ?? {}
      const productCreatedAt =
        snapshot.exists && existingProduct.createdAt instanceof admin.firestore.Timestamp
          ? (existingProduct.createdAt as admin.firestore.Timestamp)
          : now
      const productData: admin.firestore.DocumentData = {
        ...seed.data,
        createdAt: productCreatedAt,
        updatedAt: now,
      }
      await ref.set(productData, { merge: true })
      return { id: ref.id, data: productData }
    }),
  )

  const customerResults = await Promise.all(
    customerSeeds.map(async seed => {
      const ref = defaultDb.collection('customers').doc(seed.id)
      const snapshot = await ref.get()
      const existingCustomer = snapshot.data() ?? {}
      const customerCreatedAt =
        snapshot.exists && existingCustomer.createdAt instanceof admin.firestore.Timestamp
          ? (existingCustomer.createdAt as admin.firestore.Timestamp)
          : now
      const customerData: admin.firestore.DocumentData = {
        ...seed.data,
        createdAt: customerCreatedAt,
        updatedAt: now,
      }
      await ref.set(customerData, { merge: true })
      return { id: ref.id, data: customerData }
    }),
  )

  return {
    ok: true,
    storeId,
    role: resolvedRole,
    spreadsheetId: sheetRow.spreadsheetId,
    teamMember: { id: memberRef.id, data: serializeFirestoreData(memberData) },
    claims,
    store: { id: storeRef.id, data: serializeFirestoreData(storeData) },
    products: productResults.map(item => ({ id: item.id, data: serializeFirestoreData(item.data) })),
    customers: customerResults.map(item => ({ id: item.id, data: serializeFirestoreData(item.data) })),
  }
    },
    {
      resolveStoreId: (rawData, context) => {
        if (rawData && typeof rawData === 'object' && 'storeId' in (rawData as Record<string, unknown>)) {
          const candidate = (rawData as { storeId?: unknown }).storeId
          if (typeof candidate === 'string') {
            const trimmed = candidate.trim()
            if (trimmed) {
              return trimmed
            }
          }
        }
        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext
        return context.auth?.uid ?? null
      },
    },
  ),
)

export const manageStaffAccount = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.MANAGE_STAFF_ACCOUNT,
    async (data, context) => {
      assertOwnerAccess(context)

      const { storeId, email, role, password } = normalizeManageStaffPayload(data as ManageStaffPayload)
      const invitedBy = context.auth?.uid ?? null
      const { record, created } = await ensureAuthUser(email, password)

      const memberRef = rosterDb.collection('teamMembers').doc(record.uid)
      const memberSnap = await memberRef.get()
      const timestamp = admin.firestore.FieldValue.serverTimestamp()
      const existingMemberData = memberSnap.data() ?? {}
      const existingLastSeen = existingMemberData.lastSeenAt

      const memberData: admin.firestore.DocumentData = {
        uid: record.uid,
        email,
        storeId,
        role,
        invitedBy,
        updatedAt: timestamp,
      }

      if (!memberSnap.exists) {
        memberData.createdAt = timestamp
        memberData.lastSeenAt = null
      } else if (existingLastSeen instanceof admin.firestore.Timestamp) {
        memberData.lastSeenAt = existingLastSeen
      }

      await memberRef.set(memberData, { merge: true })
      return { ok: true, role, email, uid: record.uid, created, storeId }
    },
    {
      resolveStoreId: (rawData, context) => {
        if (rawData && typeof rawData === 'object' && 'storeId' in (rawData as Record<string, unknown>)) {
          const candidate = (rawData as { storeId?: unknown }).storeId
          if (typeof candidate === 'string') {
            const trimmed = candidate.trim()
            if (trimmed) {
              return trimmed
            }
          }
        }
        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext
        return context.auth?.uid ?? null
      },
    },
  ),
)

export const revokeStaffAccess = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.REVOKE_STAFF_ACCESS,
    async (data, context) => {
      assertOwnerAccess(context)

      const { storeId, uid } = normalizeRevokeStaffAccessPayload(data as RevokeStaffAccessPayload)

      const memberRef = rosterDb.collection('teamMembers').doc(uid)
      const memberSnap = await memberRef.get()
      if (!memberSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Team member not found')
      }

      const memberData = memberSnap.data() ?? {}
      const memberStoreId =
        typeof memberData.storeId === 'string' ? (memberData.storeId as string).trim() : ''
      if (memberStoreId !== storeId) {
        throw new functions.https.HttpsError('permission-denied', 'Cannot revoke access for this user')
      }

      const memberRole = typeof memberData.role === 'string' ? memberData.role.trim() : ''
      if (memberRole === 'owner') {
        throw new functions.https.HttpsError('failed-precondition', 'Cannot revoke access for owners')
      }

      await memberRef.delete()

      await admin
        .auth()
        .setCustomUserClaims(uid, {})
        .catch(error => {
          functions.logger.warn('[revokeStaffAccess] Failed to clear custom claims', { uid, error })
        })

      return { ok: true, storeId, uid }
    },
    {
      resolveStoreId: (rawData, context) => {
        if (rawData && typeof rawData === 'object' && 'storeId' in (rawData as Record<string, unknown>)) {
          const candidate = (rawData as { storeId?: unknown }).storeId
          if (typeof candidate === 'string') {
            const trimmed = candidate.trim()
            if (trimmed) {
              return trimmed
            }
          }
        }
        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext
        return context.auth?.uid ?? null
      },
    },
  ),
)

export const updateStoreProfile = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.UPDATE_STORE_PROFILE,
    async (data, context) => {
      assertOwnerAccess(context)

      const { storeId, name, timezone, currency } = normalizeUpdateStoreProfilePayload(
        data as UpdateStoreProfilePayload,
      )

      const storeRef = db.collection('stores').doc(storeId)
      const snapshot = await storeRef.get()
      if (!snapshot.exists) {
        throw new functions.https.HttpsError('not-found', 'Store not found')
      }

      const timestamp = admin.firestore.FieldValue.serverTimestamp()
      await storeRef.update({
        name,
        displayName: name,
        timezone,
        currency,
        updatedAt: timestamp,
      })
      storeTimezoneCache.set(storeId, timezone)

      return { ok: true, storeId }
    },
    {
      resolveStoreId: (rawData, context) => {
        if (rawData && typeof rawData === 'object' && 'storeId' in (rawData as Record<string, unknown>)) {
          const candidate = (rawData as { storeId?: unknown }).storeId
          if (typeof candidate === 'string') {
            const trimmed = candidate.trim()
            if (trimmed) {
              return trimmed
            }
          }
        }
        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext
        return context.auth?.uid ?? null
      },
    },
  ),
)

export const receiveStock = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.RECEIVE_STOCK,
    async (data, context) => {
      assertStaffAccess(context)

      const { productId, qty, supplier, reference, unitCost } = data || {}

      const productIdStr = typeof productId === 'string' ? productId : null
      if (!productIdStr) {
        throw new functions.https.HttpsError('invalid-argument', 'A product must be selected')
      }

      const amount = Number(qty)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Quantity must be greater than zero')
      }

      const normalizedSupplier = typeof supplier === 'string' ? supplier.trim() : ''
      if (!normalizedSupplier) {
        throw new functions.https.HttpsError('invalid-argument', 'Supplier is required')
      }

      const normalizedReference = typeof reference === 'string' ? reference.trim() : ''
      if (!normalizedReference) {
        throw new functions.https.HttpsError('invalid-argument', 'Reference number is required')
      }

      let normalizedUnitCost: number | null = null
      if (unitCost !== undefined && unitCost !== null && unitCost !== '') {
        const parsedCost = Number(unitCost)
        if (!Number.isFinite(parsedCost) || parsedCost < 0) {
          throw new functions.https.HttpsError('invalid-argument', 'Cost must be zero or greater when provided')
        }
        normalizedUnitCost = parsedCost
      }

      const productRef = db.collection('products').doc(productIdStr)
      const receiptRef = db.collection('receipts').doc()
      const ledgerRef = db.collection('ledger').doc()

      await db.runTransaction(async tx => {
        const pSnap = await tx.get(productRef)
        if (!pSnap.exists) {
          throw new functions.https.HttpsError('failed-precondition', 'Bad product')
        }

        const productStoreIdRaw = pSnap.get('storeId')
        const productStoreId = typeof productStoreIdRaw === 'string' ? productStoreIdRaw.trim() : null

        const currentStock = Number(pSnap.get('stockCount') || 0)
        const nextStock = currentStock + amount
        const timestamp = admin.firestore.FieldValue.serverTimestamp()

        tx.update(productRef, {
          stockCount: nextStock,
          updatedAt: timestamp,
          lastReceivedAt: timestamp,
          lastReceivedQty: amount,
          lastReceivedCost: normalizedUnitCost,
        })

        const totalCost =
          normalizedUnitCost === null ? null : Math.round((normalizedUnitCost * amount + Number.EPSILON) * 100) / 100

        tx.set(receiptRef, {
          productId: productIdStr,
          qty: amount,
          supplier: normalizedSupplier,
          reference: normalizedReference,
          unitCost: normalizedUnitCost,
          totalCost,
          receivedBy: context.auth?.uid ?? null,
          createdAt: timestamp,
          storeId: productStoreId,
        })

        tx.set(ledgerRef, {
          productId: productIdStr,
          qtyChange: amount,
          type: 'receipt',
          refId: receiptRef.id,
          storeId: productStoreId,
          createdAt: timestamp,
        })
      })

      return { ok: true, receiptId: receiptRef.id }
    },
    {
      resolveStoreId: async (rawData, context) => {
        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext

        if (rawData && typeof rawData === 'object' && 'productId' in (rawData as Record<string, unknown>)) {
          const candidate = (rawData as { productId?: unknown }).productId
          const productIdValue = typeof candidate === 'string' ? candidate.trim() : ''
          if (productIdValue) {
            try {
              const productSnap = await db.collection('products').doc(productIdValue).get()
              const storeIdRaw = productSnap?.get('storeId')
              if (typeof storeIdRaw === 'string') {
                const trimmed = storeIdRaw.trim()
                if (trimmed) {
                  return trimmed
                }
              }
            } catch (error) {
              functions.logger.warn('[receiveStock] Failed to resolve product storeId for telemetry', {
                error,
              })
            }
          }
        }

        return context.auth?.uid ?? null
      },
    },
  ),
)

export const onSaleCreate = functions.firestore
  .document('sales/{saleId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    if (!data) return

    const storeIdRaw = (data.storeId ?? data.branchId) as unknown
    const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
    if (!storeId) {
      functions.logger.warn('[dailySummaries] Sale created without storeId', { saleId: snapshot.id })
      return
    }

    const { dateKey, timestamp } = await resolveStoreDateKey(storeId, data.createdAt, context.timestamp)

    const saleTotal = Math.max(0, coerceNumber(data.total))
    const tenderStats = collectTenderStats(data.tenders)
    let tenderMethods = [...tenderStats.methods]
    let cardTotalIncrement = tenderStats.cardTotal
    let cashTotalIncrement = tenderStats.cashTotal

    if (tenderMethods.length === 0) {
      const legacyPayment = (data.payment ?? {}) as Record<string, unknown>
      const paymentMethod = typeof legacyPayment.method === 'string' ? legacyPayment.method : ''
      const normalizedMethod = paymentMethod.trim().toLowerCase()
      const label = normalizePaymentMethod(paymentMethod)
      if (label) {
        tenderMethods = [label]
      }
      if (normalizedMethod === 'cash') {
        cashTotalIncrement = saleTotal
      } else if (normalizedMethod === 'card' || normalizedMethod === 'mobile') {
        cardTotalIncrement = saleTotal
      }
    }

    const productStatAccumulator = new Map<
      string,
      { units: number; revenue: number; name?: string }
    >()
    if (Array.isArray(data.items)) {
      for (const rawItem of data.items as unknown[]) {
        if (!rawItem || typeof rawItem !== 'object') continue
        const item = rawItem as Record<string, unknown>
        const rawProductId =
          (typeof item.productId === 'string' ? item.productId : undefined) ??
          (typeof item.id === 'string' ? item.id : undefined)
        const productId = rawProductId ? rawProductId.trim() : ''
        if (!productId) continue

        const quantityValue = coerceNumber(item.qty ?? item.quantity ?? item.units ?? 0)
        const quantity = Math.max(0, quantityValue)
        if (quantity === 0) continue

        const nameValue = typeof item.name === 'string' ? item.name.trim() : ''
        const priceValue = coerceNumber(item.price ?? item.unitPrice ?? 0)
        let revenue = Math.max(0, coerceNumber(item.total ?? item.subtotal ?? 0))
        if (revenue === 0 && priceValue > 0) {
          revenue = Math.max(0, priceValue * quantity)
        }

        const existing = productStatAccumulator.get(productId) ?? { units: 0, revenue: 0, name: undefined }
        existing.units += quantity
        existing.revenue += revenue
        if (!existing.name && nameValue) {
          existing.name = nameValue
        }
        productStatAccumulator.set(productId, existing)
      }
    }

    const productStatsUpdates =
      productStatAccumulator.size > 0
        ? Array.from(productStatAccumulator.entries()).map(([productId, value]) => ({
            productId,
            units: value.units,
            revenue: value.revenue,
            name: value.name,
          }))
        : undefined

    await upsertDailySummaryDoc(storeId, dateKey, {
      increments: {
        salesCount: 1,
        salesTotal: saleTotal,
        cardTotal: cardTotalIncrement,
        cashTotal: cashTotalIncrement,
      },
      lastActivityAt: timestamp,
      productStats: productStatsUpdates,
    })

    const customer = data.customer as Record<string, unknown> | undefined
    const customerId = typeof customer?.id === 'string' ? (customer.id as string) : undefined
    const summary = formatSaleSummary(saleTotal, tenderMethods)

    await recordActivityEntry({
      storeId,
      dateKey,
      at: timestamp,
      type: 'sale',
      summary,
      refs: {
        saleId: snapshot.id,
        customerId,
      },
    })
  })

export const onReceiptCreate = functions.firestore
  .document('receipts/{receiptId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    if (!data) return

    const storeIdRaw = data.storeId as unknown
    const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
    if (!storeId) {
      functions.logger.warn('[dailySummaries] Receipt created without storeId', {
        receiptId: snapshot.id,
      })
      return
    }

    const { dateKey, timestamp } = await resolveStoreDateKey(storeId, data.createdAt, context.timestamp)
    const unitsReceived = Math.max(0, coerceNumber(data.qty))
    const receiptCostTotal = Math.max(0, coerceNumber(data.totalCost))

    await upsertDailySummaryDoc(storeId, dateKey, {
      increments: {
        receiptsCount: 1,
        unitsReceived,
        receiptCostTotal,
      },
      lastActivityAt: timestamp,
    })

    const productId = typeof data.productId === 'string' ? data.productId : null
    const summary = formatReceiptSummary(unitsReceived, productId, receiptCostTotal)

    await recordActivityEntry({
      storeId,
      dateKey,
      at: timestamp,
      type: 'receipt',
      summary,
      refs: {
        receiptId: snapshot.id,
        productId: productId ?? undefined,
      },
    })
  })

export const onCustomerCreate = functions.firestore
  .document('customers/{customerId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    if (!data) return

    const storeIdRaw = data.storeId as unknown
    const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
    if (!storeId) {
      functions.logger.warn('[dailySummaries] Customer created without storeId', {
        customerId: snapshot.id,
      })
      return
    }

    const { dateKey, timestamp } = await resolveStoreDateKey(storeId, data.createdAt, context.timestamp)

    await upsertDailySummaryDoc(storeId, dateKey, {
      increments: {
        newCustomersCount: 1,
      },
      lastActivityAt: timestamp,
    })

    const nameCandidate =
      typeof data.name === 'string'
        ? data.name
        : typeof data.displayName === 'string'
          ? data.displayName
          : null
    const summary = formatCustomerSummary(nameCandidate)

    await recordActivityEntry({
      storeId,
      dateKey,
      at: timestamp,
      type: 'customer',
      summary,
      refs: {
        customerId: snapshot.id,
      },
    })
  })

export const onCloseoutCreate = functions.firestore
  .document('closeouts/{closeoutId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    if (!data) return

    const storeIdRaw = data.storeId as unknown
    const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
    if (!storeId) {
      functions.logger.warn('[dailySummaries] Closeout created without storeId', {
        closeoutId: snapshot.id,
      })
      return
    }

    const sourceTimestamp = data.closedAt ?? data.createdAt
    const { dateKey, timestamp } = await resolveStoreDateKey(
      storeId,
      sourceTimestamp,
      context.timestamp,
    )

    const countedCash = coerceNumber(data.countedCash)
    const expectedCash = coerceNumber(data.expectedCash)
    const hasVarianceField = Object.prototype.hasOwnProperty.call(data, 'variance')
    const varianceValue = hasVarianceField
      ? coerceNumber(data.variance)
      : countedCash - expectedCash

    const increments: Record<string, number> = { closeoutsCount: 1 }
    if (countedCash !== 0) {
      increments.closeoutCountedTotal = countedCash
    }
    if (expectedCash !== 0) {
      increments.closeoutExpectedTotal = expectedCash
    }
    if (varianceValue !== 0) {
      increments.closeoutVarianceTotal = varianceValue
    }

    await upsertDailySummaryDoc(storeId, dateKey, {
      increments,
      lastActivityAt: timestamp,
    })

    const refs: Record<string, unknown> = {
      closeoutId: snapshot.id,
    }

    const closedBy = data.closedBy as Record<string, unknown> | undefined
    const closedByUid =
      closedBy && typeof closedBy.uid === 'string' ? closedBy.uid.trim() : ''
    if (closedByUid) {
      refs.userId = closedByUid
    }

    const summary = formatCloseoutSummary(countedCash, varianceValue)

    await recordActivityEntry({
      storeId,
      dateKey,
      at: timestamp,
      type: 'closeout',
      summary,
      refs,
    })
  })

export const runNightlyDataHygiene = functions.pubsub
  .schedule('0 3 * * *')
  .timeZone('UTC')
  .onRun(async () => {
    const referenceDate = new Date()

    try {
      const storesSnapshot = await db.collection('stores').get()
      for (const doc of storesSnapshot.docs) {
        const storeId = doc.id.trim()
        if (!storeId) {
          continue
        }

        const timezoneValue = normalizeTimezone(doc.get('timezone'))
        if (timezoneValue) {
          storeTimezoneCache.set(storeId, timezoneValue)
        }

        try {
          await recomputeDailySummaryForStore(storeId, referenceDate)
        } catch (error) {
          functions.logger.error('[nightlyDataHygiene] Failed to recompute summary', {
            storeId,
            error,
          })
        }
      }
    } catch (error) {
      functions.logger.error('[nightlyDataHygiene] Failed to iterate stores', { error })
    }

    try {
      await cleanActivityDocuments()
    } catch (error) {
      functions.logger.error('[nightlyDataHygiene] Failed to clean activities', { error })
    }
  })

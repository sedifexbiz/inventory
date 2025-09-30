const assert = require('assert')
const Module = require('module')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')

let currentDefaultDb
const apps = []

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const firestore = () => currentDefaultDb
    firestore.FieldValue = {
      serverTimestamp: () => MockTimestamp.now(),
      increment: amount => ({ __mockIncrement: amount }),
      delete: () => ({ __mockDelete: true }),
    }
    firestore.Timestamp = MockTimestamp

    return {
      initializeApp: () => {
        const app = { name: 'mock-app' }
        apps[0] = app
        return app
      },
      app: () => apps[0] || null,
      apps,
      firestore,
      auth: () => ({
        getUser: async () => ({ customClaims: undefined }),
        getUserByEmail: async () => {
          const err = new Error('not found')
          err.code = 'auth/user-not-found'
          throw err
        },
        updateUser: async () => {},
        createUser: async () => ({ uid: 'new-user' }),
        setCustomUserClaims: async () => {},
      }),
    }
  }

  if (request === 'firebase-admin/firestore') {
    return {
      getFirestore: () => currentDefaultDb,
    }
  }

  return originalLoad(request, parent, isMain)
}

function loadFunctionsModule() {
  apps.length = 0
  delete require.cache[require.resolve('../lib/firestore.js')]
  delete require.cache[require.resolve('../lib/index.js')]
  return require('../lib/index.js')
}

function getPart(parts, type, fallback) {
  const part = parts.find(entry => entry.type === type)
  if (!part) return fallback
  const parsed = Number(part.value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getMillisForZonedDate(timeZone, year, month, day) {
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
    const resolvedYear = getPart(parts, 'year', year)
    const resolvedMonth = getPart(parts, 'month', month)
    const resolvedDay = getPart(parts, 'day', day)
    const resolvedHour = getPart(parts, 'hour', 0)
    const resolvedMinute = getPart(parts, 'minute', 0)
    const resolvedSecond = getPart(parts, 'second', 0)

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
    return baseMillis
  }
}

function computePreviousDayWindow(timeZone, referenceDate) {
  let effectiveTimeZone = timeZone || 'UTC'
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch (error) {
    effectiveTimeZone = 'UTC'
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  const parts = formatter.formatToParts(referenceDate)
  const currentYear = getPart(parts, 'year', referenceDate.getUTCFullYear())
  const currentMonth = getPart(parts, 'month', referenceDate.getUTCMonth() + 1)
  const currentDay = getPart(parts, 'day', referenceDate.getUTCDate())

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
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: effectiveTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const dateKey = keyFormatter.format(start)

  return { start, end, dateKey }
}

async function runNightlyDataHygieneTest() {
  const window = computePreviousDayWindow('America/New_York', new Date())
  const saleMillisOne = window.start.getTime() + 4 * 60 * 60 * 1000
  const saleMillisTwo = window.start.getTime() + 6 * 60 * 60 * 1000
  const receiptMillis = window.start.getTime() + 3 * 60 * 60 * 1000
  const customerMillis = window.start.getTime() + 8 * 60 * 60 * 1000
  const closeoutMillis = window.end.getTime() - 60 * 60 * 1000
  const activityMillis = window.start.getTime() + 2 * 60 * 60 * 1000

  currentDefaultDb = new MockFirestore({
    'stores/store-001': { timezone: 'America/New_York' },
    'sales/sale-1': {
      storeId: 'store-001',
      total: 150,
      createdAt: MockTimestamp.fromMillis(saleMillisOne),
      tenders: { cash: 50, card: 100 },
    },
    'sales/sale-2': {
      storeId: 'store-001',
      total: 80,
      createdAt: MockTimestamp.fromMillis(saleMillisTwo),
      payment: { method: 'cash' },
    },
    'receipts/receipt-1': {
      storeId: 'store-001',
      qty: 10,
      totalCost: 200,
      createdAt: MockTimestamp.fromMillis(receiptMillis),
    },
    'customers/customer-1': {
      storeId: 'store-001',
      createdAt: MockTimestamp.fromMillis(customerMillis),
    },
    'closeouts/closeout-1': {
      storeId: 'store-001',
      closedAt: MockTimestamp.fromMillis(closeoutMillis),
      countedCash: 500,
      expectedCash: 480,
    },
    [`dailySummaries/store-001_${window.dateKey}`]: {
      storeId: 'store-001',
      dateKey: window.dateKey,
      salesCount: 1,
      salesTotal: 25,
      cardTotal: 0,
      cashTotal: 25,
      receiptsCount: 0,
      unitsReceived: 0,
      receiptCostTotal: 0,
      newCustomersCount: 0,
      closeoutsCount: 0,
      closeoutCountedTotal: 0,
      closeoutExpectedTotal: 0,
      closeoutVarianceTotal: 0,
      lastActivityAt: { _millis: window.start.getTime() },
    },
    'activities/activity-orphan': {
      storeId: '',
      type: 'sale',
      at: MockTimestamp.fromMillis(activityMillis),
    },
    'activities/activity-missing': {
      storeId: 'store-001',
      dateKey: '',
      type: 'sale',
      at: MockTimestamp.fromMillis(activityMillis),
    },
  })

  const { runNightlyDataHygiene } = loadFunctionsModule()

  assert.ok(runNightlyDataHygiene, 'Expected nightly hygiene function export')

  await runNightlyDataHygiene.run()

  const summary = currentDefaultDb.getDoc(`dailySummaries/store-001_${window.dateKey}`)
  assert.ok(summary, 'Expected daily summary document to exist')
  assert.strictEqual(summary.salesCount, 2)
  assert.strictEqual(summary.salesTotal, 230)
  assert.strictEqual(summary.cardTotal, 100)
  assert.strictEqual(summary.cashTotal, 130)
  assert.strictEqual(summary.receiptsCount, 1)
  assert.strictEqual(summary.unitsReceived, 10)
  assert.strictEqual(summary.receiptCostTotal, 200)
  assert.strictEqual(summary.newCustomersCount, 1)
  assert.strictEqual(summary.closeoutsCount, 1)
  assert.strictEqual(summary.closeoutCountedTotal, 500)
  assert.strictEqual(summary.closeoutExpectedTotal, 480)
  assert.strictEqual(summary.closeoutVarianceTotal, 20)
  assert.ok(summary.lastActivityAt)
  assert.strictEqual(summary.lastActivityAt._millis, closeoutMillis)

  const orphan = currentDefaultDb.getDoc('activities/activity-orphan')
  assert.strictEqual(orphan, undefined, 'Expected orphaned activity to be deleted')

  const repairedActivity = currentDefaultDb.getDoc('activities/activity-missing')
  assert.ok(repairedActivity, 'Expected activity with missing dateKey to remain')
  assert.strictEqual(repairedActivity.dateKey, window.dateKey)
}

runNightlyDataHygieneTest()
  .then(() => {
    Module._load = originalLoad
  })
  .catch(error => {
    Module._load = originalLoad
    console.error(error)
    process.exit(1)
  })

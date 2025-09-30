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

const createSnapshot = (id, data) => ({
  id,
  data: () => ({ ...data }),
})

async function runSalesAggregationTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-123': { timezone: 'Africa/Accra' },
  })

  const { onSaleCreate } = loadFunctionsModule()

  const saleTimestamp = MockTimestamp.fromMillis(Date.UTC(2024, 2, 2, 9, 15))
  await onSaleCreate.run(
    createSnapshot('sale-1', {
      storeId: 'store-123',
      total: 120,
      tenders: { cash: 120 },
      createdAt: saleTimestamp,
      items: [
        { productId: 'product-a', name: 'Widget A', qty: 2, price: 30, total: 60 },
        { productId: 'product-b', name: 'Widget B', qty: 1, price: 60, total: 60 },
      ],
    }),
    {
      params: { saleId: 'sale-1' },
      timestamp: '2024-03-02T09:15:00.000Z',
    },
  )

  const summaryPath = 'dailySummaries/store-123_2024-03-02'
  const summaryAfterFirstSale = currentDefaultDb.getDoc(summaryPath)
  assert.ok(summaryAfterFirstSale, 'Expected summary document after first sale')
  assert.strictEqual(summaryAfterFirstSale.storeId, 'store-123')
  assert.strictEqual(summaryAfterFirstSale.salesCount, 1)
  assert.strictEqual(summaryAfterFirstSale.salesTotal, 120)
  assert.strictEqual(summaryAfterFirstSale.cashTotal, 120)
  assert.strictEqual(summaryAfterFirstSale.cardTotal ?? 0, 0)
  assert.ok(summaryAfterFirstSale.lastActivityAt)
  assert.strictEqual(summaryAfterFirstSale.lastActivityAt._millis, saleTimestamp.toMillis())
  assert.deepStrictEqual(summaryAfterFirstSale.productStatsOrder, ['product-a', 'product-b'])
  assert.deepStrictEqual(summaryAfterFirstSale.productStats['product-a'], {
    name: 'Widget A',
    units: 2,
    revenue: 60,
  })
  assert.deepStrictEqual(summaryAfterFirstSale.productStats['product-b'], {
    name: 'Widget B',
    units: 1,
    revenue: 60,
  })

  const secondSaleTimestamp = MockTimestamp.fromMillis(Date.UTC(2024, 2, 2, 15, 45))
  await onSaleCreate.run(
    createSnapshot('sale-2', {
      storeId: 'store-123',
      total: 208,
      tenders: { card: 208 },
      createdAt: secondSaleTimestamp,
      items: [
        { productId: 'product-a', name: 'Widget A', qty: 1, price: 40, total: 40 },
        { productId: 'product-c', name: 'Widget C', qty: 4, price: 10, total: 40 },
        { productId: 'product-d', name: 'Widget D', qty: 5, price: 5, total: 25 },
        { productId: 'product-e', name: 'Widget E', qty: 2, price: 20, total: 40 },
        { productId: 'product-f', name: 'Widget F', qty: 3, price: 15, total: 45 },
        { productId: 'product-g', name: 'Widget G', qty: 6, price: 3, total: 18 },
      ],
    }),
    {
      params: { saleId: 'sale-2' },
      timestamp: '2024-03-02T15:45:00.000Z',
    },
  )

  const summaryAfterSecondSale = currentDefaultDb.getDoc(summaryPath)
  assert.ok(summaryAfterSecondSale, 'Expected summary document after second sale')
  assert.strictEqual(summaryAfterSecondSale.salesCount, 2)
  assert.strictEqual(summaryAfterSecondSale.salesTotal, 328)
  assert.strictEqual(summaryAfterSecondSale.cashTotal, 120)
  assert.strictEqual(summaryAfterSecondSale.cardTotal, 208)
  assert.ok(summaryAfterSecondSale.updatedAt)
  assert.strictEqual(summaryAfterSecondSale.lastActivityAt._millis, secondSaleTimestamp.toMillis())
  assert.deepStrictEqual(summaryAfterSecondSale.productStatsOrder, [
    'product-g',
    'product-d',
    'product-c',
    'product-a',
    'product-f',
  ])
  assert.deepStrictEqual(summaryAfterSecondSale.productStats['product-g'], {
    name: 'Widget G',
    units: 6,
    revenue: 18,
  })
  assert.deepStrictEqual(summaryAfterSecondSale.productStats['product-d'], {
    name: 'Widget D',
    units: 5,
    revenue: 25,
  })
  assert.deepStrictEqual(summaryAfterSecondSale.productStats['product-c'], {
    name: 'Widget C',
    units: 4,
    revenue: 40,
  })
  assert.deepStrictEqual(summaryAfterSecondSale.productStats['product-a'], {
    name: 'Widget A',
    units: 3,
    revenue: 100,
  })
  assert.deepStrictEqual(summaryAfterSecondSale.productStats['product-f'], {
    name: 'Widget F',
    units: 3,
    revenue: 45,
  })
  assert.strictEqual(summaryAfterSecondSale.productStats['product-b'], undefined)
  assert.strictEqual(summaryAfterSecondSale.productStats['product-e'], undefined)

  const activities = currentDefaultDb.listCollection('activities')
  const saleActivities = activities.filter(entry => entry.data.type === 'sale')
  assert.strictEqual(saleActivities.length, 2, 'Expected two sale activities')
  for (const activity of saleActivities) {
    assert.strictEqual(activity.data.storeId, 'store-123')
    assert.strictEqual(activity.data.dateKey, '2024-03-02')
    assert.ok(activity.data.summary.includes('sale'), 'Expected sale summary text')
    assert.ok(activity.data.refs.saleId)
    assert.ok(activity.data.at)
  }
}

async function runReceiptAggregationTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-456': { timezone: 'America/New_York' },
  })

  const { onReceiptCreate } = loadFunctionsModule()
  const eventTimestamp = '2024-03-02T02:30:00.000Z'

  await onReceiptCreate.run(
    createSnapshot('receipt-1', {
      storeId: 'store-456',
      productId: 'product-9',
      qty: 5,
      totalCost: 150,
    }),
    {
      params: { receiptId: 'receipt-1' },
      timestamp: eventTimestamp,
    },
  )

  const summaryPath = 'dailySummaries/store-456_2024-03-01'
  const summaryDoc = currentDefaultDb.getDoc(summaryPath)
  assert.ok(summaryDoc, 'Expected receipt summary document')
  assert.strictEqual(summaryDoc.receiptsCount, 1)
  assert.strictEqual(summaryDoc.unitsReceived, 5)
  assert.strictEqual(summaryDoc.receiptCostTotal, 150)
  assert.strictEqual(summaryDoc.lastActivityAt._millis, Date.parse(eventTimestamp))

  const activities = currentDefaultDb.listCollection('activities')
  const receiptActivity = activities.find(entry => entry.data.type === 'receipt')
  assert.ok(receiptActivity, 'Expected receipt activity entry')
  assert.strictEqual(receiptActivity.data.storeId, 'store-456')
  assert.strictEqual(receiptActivity.data.dateKey, '2024-03-01')
  assert.strictEqual(receiptActivity.data.refs.receiptId, 'receipt-1')
  assert.ok(receiptActivity.data.summary.includes('Received'))
}

async function runCustomerAggregationTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-789': {},
  })

  const { onCustomerCreate } = loadFunctionsModule()
  const createdAt = MockTimestamp.fromMillis(Date.UTC(2024, 3, 15, 12))

  await onCustomerCreate.run(
    createSnapshot('customer-1', {
      storeId: 'store-789',
      name: 'Ada Lovelace',
      createdAt,
    }),
    {
      params: { customerId: 'customer-1' },
      timestamp: '2024-04-15T12:00:00.000Z',
    },
  )

  const summaryPath = 'dailySummaries/store-789_2024-04-15'
  const summaryDoc = currentDefaultDb.getDoc(summaryPath)
  assert.ok(summaryDoc, 'Expected customer summary document')
  assert.strictEqual(summaryDoc.newCustomersCount, 1)
  assert.strictEqual(summaryDoc.storeId, 'store-789')
  assert.strictEqual(summaryDoc.dateKey, '2024-04-15')

  const activities = currentDefaultDb.listCollection('activities')
  const customerActivity = activities.find(entry => entry.data.type === 'customer')
  assert.ok(customerActivity, 'Expected customer activity entry')
  assert.strictEqual(customerActivity.data.refs.customerId, 'customer-1')
  assert.ok(customerActivity.data.summary.includes('customer'))
}

async function run() {
  await runSalesAggregationTest()
  await runReceiptAggregationTest()
  await runCustomerAggregationTest()
  console.log('dailySummaries tests passed')
}

run()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    Module._load = originalLoad
  })

const assert = require('assert')
const Module = require('module')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')

let currentDb
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const apps = []
    const firestore = () => currentDb
    firestore.FieldValue = {
      serverTimestamp: () => ({ __mockServerTimestamp: true }),
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
        getUser: async () => null,
        setCustomUserClaims: async () => {},
        getUserByEmail: async () => {
          const err = new Error('not found')
          err.code = 'auth/user-not-found'
          throw err
        },
        updateUser: async () => {},
        createUser: async () => ({ uid: 'new-user' }),
      }),
    }
  }
  if (request === 'firebase-admin/firestore') {
    return {
      getFirestore: () => currentDb,
    }
  }
  if (request === './googleSheets' || request.endsWith('/googleSheets')) {
    return {
      fetchClientRowByEmail: async () => null,
      getDefaultSpreadsheetId: () => 'test-sheet',
    }
  }
  return originalLoad(request, parent, isMain)
}

async function run() {
  currentDb = new MockFirestore({
    'products/prod-1': { stockCount: 5 },
  })

  delete require.cache[require.resolve('../lib/index.js')]
  const { commitSale } = require('../lib/index.js')

  const context = {
    auth: {
      uid: 'cashier-1',
      token: { role: 'staff' },
    },
  }

  const payload = {
    branchId: 'branch-1',
    cashierId: 'cashier-1',
    saleId: 'sale-123',
    totals: { total: 100, taxTotal: 10 },
    payment: { method: 'cash' },
    customer: { name: 'Alice' },
    items: [{ productId: 'prod-1', name: 'Widget', qty: 1, price: 100, taxRate: 0.1 }],
  }

  const result = await commitSale.run(payload, context)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.saleId, 'sale-123')

  const saleDoc = currentDb.getDoc('sales/sale-123')
  assert.ok(saleDoc)
  assert.strictEqual(saleDoc.branchId, 'branch-1')

  const saleItems = currentDb.listCollection('saleItems')
  assert.strictEqual(saleItems.length, 1)
  assert.strictEqual(saleItems[0].data.saleId, 'sale-123')

  const productDoc = currentDb.getDoc('products/prod-1')
  assert.strictEqual(productDoc.stockCount, 4)

  let error
  try {
    await commitSale.run(payload, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected duplicate sale to throw')
  assert.strictEqual(error.code, 'already-exists')

  const ledgerEntries = currentDb.listCollection('ledger')
  assert.strictEqual(ledgerEntries.length, 1)
  assert.strictEqual(ledgerEntries[0].data.refId, 'sale-123')

  console.log('commitSale tests passed')
}

run()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    Module._load = originalLoad
  })

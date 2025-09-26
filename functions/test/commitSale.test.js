const assert = require('assert')
const Module = require('module')

class MockDocSnapshot {
  constructor(data) {
    this._data = data
  }

  get exists() {
    return this._data !== undefined
  }

  data() {
    return this._data ? { ...this._data } : undefined
  }

  get(field) {
    return this._data ? this._data[field] : undefined
  }
}

class MockDocumentReference {
  constructor(db, path) {
    this._db = db
    this.path = path
  }

  get id() {
    const parts = this.path.split('/')
    return parts[parts.length - 1]
  }

  collection(name) {
    return new MockCollectionReference(this._db, `${this.path}/${name}`)
  }
}

class MockCollectionReference {
  constructor(db, path) {
    this._db = db
    this._path = path
  }

  doc(id) {
    const docId = id || this._db.generateId()
    return new MockDocumentReference(this._db, `${this._path}/${docId}`)
  }
}

class MockTransaction {
  constructor(db) {
    this._db = db
    this._writes = new Map()
  }

  async get(ref) {
    const pending = this._writes.get(ref.path)
    const base = pending || this._db.getRaw(ref.path)
    return new MockDocSnapshot(base ? { ...base } : undefined)
  }

  set(ref, data) {
    this._writes.set(ref.path, clone(data))
  }

  update(ref, data) {
    const existing = this._writes.get(ref.path) || this._db.getRaw(ref.path)
    if (!existing) {
      throw new Error('Document does not exist')
    }
    this._writes.set(ref.path, { ...clone(existing), ...clone(data) })
  }

  commit() {
    for (const [path, value] of this._writes.entries()) {
      this._db.setRaw(path, value)
    }
  }
}

class MockFirestore {
  constructor(initialData = {}) {
    this._store = new Map()
    this._idCounter = 0
    for (const [path, value] of Object.entries(initialData)) {
      this.setRaw(path, value)
    }
  }

  collection(path) {
    return new MockCollectionReference(this, path)
  }

  generateId() {
    this._idCounter += 1
    return `mock-id-${this._idCounter}`
  }

  async runTransaction(fn) {
    const tx = new MockTransaction(this)
    const result = await fn(tx)
    tx.commit()
    return result
  }

  getRaw(path) {
    const value = this._store.get(path)
    return value ? { ...value } : undefined
  }

  setRaw(path, data) {
    this._store.set(path, clone(data))
  }

  getDoc(path) {
    return this.getRaw(path)
  }

  listCollection(path) {
    const prefix = `${path}/`
    const results = []
    for (const [docPath, value] of this._store.entries()) {
      if (docPath.startsWith(prefix)) {
        const remainder = docPath.slice(prefix.length)
        if (!remainder.includes('/')) {
          results.push({ id: remainder, data: { ...value } })
        }
      }
    }
    return results
  }
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

let currentDb
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const firestore = () => currentDb
    firestore.FieldValue = {
      serverTimestamp: () => ({ __mockServerTimestamp: true }),
    }

    return {
      initializeApp: () => {},
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
  return originalLoad(request, parent, isMain)
}

async function run() {
  currentDb = new MockFirestore({
    'products/prod-1': { storeId: 'store-1', stockCount: 5 },
  })

  delete require.cache[require.resolve('../lib/index.js')]
  const { commitSale } = require('../lib/index.js')

  const context = {
    auth: {
      uid: 'cashier-1',
      token: { stores: ['store-1'] },
    },
  }

  const payload = {
    storeId: 'store-1',
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
  assert.strictEqual(saleDoc.storeId, 'store-1')

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

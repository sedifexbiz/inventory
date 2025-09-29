const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')

let currentDefaultDb
let sheetRowMock
const apps = []
let lastCustomClaims

function normalizeHeader(header) {
  if (typeof header !== 'string') return ''
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const firestore = () => currentDefaultDb
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
        getUser: async () => ({ customClaims: lastCustomClaims || undefined }),
        getUserByEmail: async () => {
          const err = new Error('not found')
          err.code = 'auth/user-not-found'
          throw err
        },
        updateUser: async () => {},
        createUser: async () => ({ uid: 'new-user' }),
        setCustomUserClaims: async (_uid, claims) => {
          lastCustomClaims = { ...claims }
        },
      }),
    }
  }

  if (request === 'firebase-admin/firestore') {
    return {
      getFirestore: () => currentDefaultDb,
    }
  }

  if (request === './googleSheets' || request.endsWith(`${path.sep}googleSheets`)) {
    return {
      fetchClientRowByEmail: async () => sheetRowMock,
      getDefaultSpreadsheetId: () => 'sheet-123',
      normalizeHeader,
    }
  }

  return originalLoad(request, parent, isMain)
}

function loadFunctionsModule() {
  apps.length = 0
  lastCustomClaims = null
  delete require.cache[require.resolve('../lib/firestore.js')]
  delete require.cache[require.resolve('../lib/googleSheets.js')]
  delete require.cache[require.resolve('../lib/index.js')]
  return require('../lib/index.js')
}

async function runActiveStatusTest() {
  currentDefaultDb = new MockFirestore()
  sheetRowMock = {
    spreadsheetId: 'sheet-123',
    headers: [],
    normalizedHeaders: [],
    values: [],
    record: {
      [normalizeHeader('store_id')]: 'store-001',
      [normalizeHeader('store_status')]: 'Active',
      [normalizeHeader('role')]: 'Owner',
      [normalizeHeader('member_email')]: 'owner@example.com',
      [normalizeHeader('member_name')]: 'Owner One',
      [normalizeHeader('contractStart')]: '2024-01-15',
      [normalizeHeader('contract_end')]: '2024-12-31',
      [normalizeHeader('paymentStatus')]: 'Paid',
      [normalizeHeader('amountPaid')]: '$1,234.56',
      [normalizeHeader('company')]: 'Example Company',
    },
  }

  const { resolveStoreAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'user-1',
      token: { email: 'owner@example.com' },
    },
  }

  const result = await resolveStoreAccess.run({ storeId: 'store-001' }, context)

  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.storeId, 'store-001')
  assert.strictEqual(result.role, 'owner')
  assert.deepStrictEqual(result.claims, {
    role: 'owner',
    activeStoreId: 'store-001',
  })
  assert.deepStrictEqual(lastCustomClaims, {
    role: 'owner',
    activeStoreId: 'store-001',
  })

  const expectedContractStart = Date.parse('2024-01-15T00:00:00.000Z')
  const expectedContractEnd = Date.parse('2024-12-31T00:00:00.000Z')

  const rosterDoc = currentDefaultDb.getDoc('teamMembers/user-1')
  assert.ok(rosterDoc)
  assert.strictEqual(rosterDoc.storeId, 'store-001')

  const storeDoc = currentDefaultDb.getDoc('stores/store-001')
  assert.ok(storeDoc)
  assert.strictEqual(storeDoc.status, 'Active')
  assert.strictEqual(storeDoc.contractStart._millis, expectedContractStart)
  assert.strictEqual(storeDoc.contractEnd._millis, expectedContractEnd)
  assert.strictEqual(storeDoc.paymentStatus, 'Paid')
  assert.strictEqual(storeDoc.amountPaid, 1234.56)
  assert.strictEqual(storeDoc.company, 'Example Company')

  assert.strictEqual(result.store.data.contractStart, expectedContractStart)
  assert.strictEqual(result.store.data.contractEnd, expectedContractEnd)
  assert.strictEqual(result.store.data.paymentStatus, 'Paid')
  assert.strictEqual(result.store.data.amountPaid, 1234.56)
  assert.strictEqual(result.store.data.company, 'Example Company')
}

async function runInactiveStatusTest() {
  currentDefaultDb = new MockFirestore()
  sheetRowMock = {
    spreadsheetId: 'sheet-123',
    headers: [],
    normalizedHeaders: [],
    values: [],
    record: {
      [normalizeHeader('store_id')]: 'store-002',
      [normalizeHeader('status')]: 'Contract Terminated',
      [normalizeHeader('member_email')]: 'owner@example.com',
    },
  }

  const { resolveStoreAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'user-2',
      token: { email: 'owner@example.com' },
    },
  }

  let error
  try {
    await resolveStoreAccess.run({ storeId: 'store-002' }, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected inactive contract to throw')
  assert.strictEqual(error.code, 'permission-denied')
  assert.match(
    error.message,
    /workspace contract is not active/i,
    'Expected inactive status rejection message',
  )
}

async function runStoreIdMismatchTest() {
  currentDefaultDb = new MockFirestore()
  sheetRowMock = {
    spreadsheetId: 'sheet-123',
    headers: [],
    normalizedHeaders: [],
    values: [],
    record: {
      [normalizeHeader('store_id')]: 'store-777',
      [normalizeHeader('status')]: 'Active',
      [normalizeHeader('member_email')]: 'owner@example.com',
    },
  }

  const { resolveStoreAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'user-3',
      token: { email: 'owner@example.com' },
    },
  }

  let error
  try {
    await resolveStoreAccess.run({ storeId: 'store-abc' }, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected mismatch to throw')
  assert.strictEqual(error.code, 'permission-denied')
  assert.strictEqual(
    error.message,
    'Your account is assigned to store store-777. Enter the correct store ID to continue.',
  )
}

async function runMissingStoreIdTest() {
  currentDefaultDb = new MockFirestore()
  sheetRowMock = {
    spreadsheetId: 'sheet-123',
    headers: [],
    normalizedHeaders: [],
    values: [],
    record: {
      status: 'Active',
      member_email: 'owner@example.com',
    },
  }

  const { resolveStoreAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'user-4',
      token: { email: 'owner@example.com' },
    },
  }

  let error
  try {
    await resolveStoreAccess.run({ storeId: 'store-001' }, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected missing store ID to throw')
  assert.strictEqual(error.code, 'failed-precondition')
  assert.strictEqual(
    error.message,
    'We could not confirm the store ID assigned to your Sedifex workspace. Reach out to your Sedifex administrator.',
  )
}

async function run() {
  await runActiveStatusTest()
  await runInactiveStatusTest()
  await runStoreIdMismatchTest()
  await runMissingStoreIdTest()
  console.log('resolveStoreAccess tests passed')
}

run()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    Module._load = originalLoad
  })

const assert = require('assert')
const Module = require('module')
const path = require('path')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')
const { FIREBASE_CALLABLES } = require('../lib/shared/firebaseCallables.js')

let currentDefaultDb
const apps = []

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'firebase-admin') {
    const firestore = () => currentDefaultDb
    firestore.FieldValue = {
      serverTimestamp: () => MockTimestamp.now(),
      increment: amount => ({ __mockIncrement: amount }),
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
        getUserByEmail: async email => ({ uid: `uid-for-${email}` }),
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

  if (request === './googleSheets' || request.endsWith(`${path.sep}googleSheets`)) {
    return {
      fetchClientRowByEmail: async () => null,
      getDefaultSpreadsheetId: () => 'sheet-123',
      normalizeHeader: value => (typeof value === 'string' ? value.trim().toLowerCase() : ''),
    }
  }

  return originalLoad(request, parent, isMain)
}

function clearModuleCache(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)]
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error
    }
  }
}

function loadCallablesModule() {
  apps.length = 0
  clearModuleCache('../lib/firestore.js')
  clearModuleCache('../lib/telemetry.js')
  clearModuleCache('../lib/callables.js')
  return require('../lib/callables.js')
}

function loadIndexModule() {
  apps.length = 0
  clearModuleCache('../lib/firestore.js')
  clearModuleCache('../lib/telemetry.js')
  clearModuleCache('../lib/index.js')
  return require('../lib/index.js')
}

function extractLatestLog() {
  const dateDocs = currentDefaultDb.listCollection('logs')
  assert.strictEqual(dateDocs.length, 1, 'Expected one log date document')
  const dateDoc = dateDocs[0]
  const events = currentDefaultDb.listCollection(`logs/${dateDoc.id}/events`)
  assert.strictEqual(events.length, 1, 'Expected one logged event')
  return events[0].data
}

async function runBackfillLoggingTest() {
  currentDefaultDb = new MockFirestore()
  const { backfillMyStore } = loadCallablesModule()

  const context = {
    auth: {
      uid: 'user-123',
      token: { activeStoreId: 'store-xyz' },
    },
  }

  let error
  try {
    await backfillMyStore.run({ contact: { phone: 123 } }, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected backfillMyStore to throw')
  assert.strictEqual(error.code, 'invalid-argument')

  const logEntry = extractLatestLog()
  assert.strictEqual(logEntry.route, FIREBASE_CALLABLES.BACKFILL_MY_STORE)
  assert.strictEqual(logEntry.storeId, 'store-xyz')
  assert.strictEqual(logEntry.authUid, 'user-123')
  assert.deepStrictEqual(logEntry.payloadShape, { contact: { phone: 'number' } })
  assert.strictEqual(logEntry.error.code, 'invalid-argument')
  assert.match(logEntry.error.message, /phone must be a string/i)
}

async function runManageStaffLoggingTest() {
  currentDefaultDb = new MockFirestore()
  const { manageStaffAccount } = loadIndexModule()

  const context = {
    auth: {
      uid: 'owner-1',
      token: { role: 'owner', activeStoreId: 'store-abc' },
    },
  }

  let error
  try {
    await manageStaffAccount.run(
      { storeId: 123, email: 'staff@example.com', role: 'manager' },
      context,
    )
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected manageStaffAccount to throw')
  assert.strictEqual(error.code, 'invalid-argument')

  const logEntry = extractLatestLog()
  assert.strictEqual(logEntry.route, FIREBASE_CALLABLES.MANAGE_STAFF_ACCOUNT)
  assert.strictEqual(logEntry.storeId, 'store-abc')
  assert.strictEqual(logEntry.authUid, 'owner-1')
  assert.strictEqual(logEntry.payloadShape.storeId, 'number')
  assert.strictEqual(logEntry.payloadShape.email, 'string')
  assert.strictEqual(logEntry.payloadShape.role, 'string')
  assert.strictEqual(logEntry.error.code, 'invalid-argument')
  assert.match(logEntry.error.message, /storeid is required/i)
}

async function main() {
  await runBackfillLoggingTest()
  await runManageStaffLoggingTest()
  console.log('callables logging tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

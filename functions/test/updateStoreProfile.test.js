require('ts-node/register/transpile-only')

const assert = require('assert')
const Module = require('module')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')
const { DEFAULT_CURRENCY_CODE } = require('../../shared/currency')

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

  return originalLoad(request, parent, isMain)
}

function clearModuleCache(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)]
  } catch (error) {
    if (!error || error.code !== 'MODULE_NOT_FOUND') {
      throw error
    }
  }
}

function loadFunctionsModule() {
  apps.length = 0
  clearModuleCache('../lib/firestore.js')
  clearModuleCache('../lib/telemetry.js')
  clearModuleCache('../lib/index.js')
  return require('../lib/index.js')
}

async function runOwnerUpdateTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-123': {
      name: 'Sedifex Coffee',
      displayName: 'Sedifex Coffee',
      timezone: 'UTC',
      currency: 'USD',
    },
  })

  const { updateStoreProfile } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'owner-1',
      token: { role: 'owner', activeStoreId: 'store-123' },
    },
  }

  const result = await updateStoreProfile.run(
    { storeId: 'store-123', name: 'Sedifex Labs', timezone: 'Africa/Accra', currency: 'ghs' },
    context,
  )

  assert.deepStrictEqual(result, { ok: true, storeId: 'store-123' })

  const storeDoc = currentDefaultDb.getDoc('stores/store-123')
  assert.ok(storeDoc, 'Expected store document to exist')
  assert.strictEqual(storeDoc.name, 'Sedifex Labs')
  assert.strictEqual(storeDoc.displayName, 'Sedifex Labs')
  assert.strictEqual(storeDoc.timezone, 'Africa/Accra')
  assert.strictEqual(storeDoc.currency, DEFAULT_CURRENCY_CODE)
  assert.ok(storeDoc.updatedAt, 'Expected updatedAt to be set')
}

async function runNonOwnerRejectionTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-456': {
      name: 'Test Store',
      displayName: 'Test Store',
      timezone: 'UTC',
      currency: 'USD',
    },
  })

  const { updateStoreProfile } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'staff-1',
      token: { role: 'staff', activeStoreId: 'store-456' },
    },
  }

  let error
  try {
    await updateStoreProfile.run(
      { storeId: 'store-456', name: 'Updated', timezone: 'UTC', currency: 'USD' },
      context,
    )
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected non-owner update to throw')
  assert.strictEqual(error.code, 'permission-denied')
}

async function runInvalidTimezoneTest() {
  currentDefaultDb = new MockFirestore({
    'stores/store-789': {
      name: 'Example',
      displayName: 'Example',
      timezone: 'UTC',
      currency: 'USD',
    },
  })

  const { updateStoreProfile } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'owner-2',
      token: { role: 'owner', activeStoreId: 'store-789' },
    },
  }

  let error
  try {
    await updateStoreProfile.run(
      { storeId: 'store-789', name: 'Example', timezone: 'Mars/Colony', currency: 'USD' },
      context,
    )
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected invalid timezone to throw')
  assert.strictEqual(error.code, 'invalid-argument')
  assert.match(error.message, /valid iana timezone/i)
}

async function main() {
  await runOwnerUpdateTest()
  await runNonOwnerRejectionTest()
  await runInvalidTimezoneTest()
  console.log('updateStoreProfile tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

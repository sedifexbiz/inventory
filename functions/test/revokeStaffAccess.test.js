const assert = require('assert')
const Module = require('module')
const { MockFirestore, MockTimestamp } = require('./helpers/mockFirestore')

let currentDefaultDb
const apps = []
let claimsUpdates

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
        setCustomUserClaims: async (uid, claims) => {
          claimsUpdates.push({ uid, claims })
        },
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
  claimsUpdates = []
  clearModuleCache('../lib/firestore.js')
  clearModuleCache('../lib/telemetry.js')
  clearModuleCache('../lib/index.js')
  return require('../lib/index.js')
}

async function runRevocationSuccessTest() {
  currentDefaultDb = new MockFirestore({
    'teamMembers/member-2': {
      uid: 'member-2',
      email: 'staff@example.com',
      storeId: 'store-123',
      role: 'staff',
      invitedBy: 'owner-1',
    },
  })

  const { revokeStaffAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'owner-1',
      token: { role: 'owner', activeStoreId: 'store-123' },
    },
  }

  const result = await revokeStaffAccess.run({ storeId: 'store-123', uid: 'member-2' }, context)

  assert.deepStrictEqual(result, { ok: true, storeId: 'store-123', uid: 'member-2' })
  assert.strictEqual(currentDefaultDb.getDoc('teamMembers/member-2'), undefined)
  assert.deepStrictEqual(claimsUpdates, [{ uid: 'member-2', claims: {} }])
}

async function runOwnerProtectionTest() {
  currentDefaultDb = new MockFirestore({
    'teamMembers/owner-1': {
      uid: 'owner-1',
      email: 'owner@example.com',
      storeId: 'store-123',
      role: 'owner',
      invitedBy: 'owner-1',
    },
  })

  const { revokeStaffAccess } = loadFunctionsModule()
  const context = {
    auth: {
      uid: 'owner-1',
      token: { role: 'owner', activeStoreId: 'store-123' },
    },
  }

  let error
  try {
    await revokeStaffAccess.run({ storeId: 'store-123', uid: 'owner-1' }, context)
  } catch (err) {
    error = err
  }

  assert.ok(error, 'Expected revoking owner access to throw')
  assert.strictEqual(error.code, 'failed-precondition')
  assert.ok(currentDefaultDb.getDoc('teamMembers/owner-1'), 'Owner document should remain')
}

async function main() {
  await runRevocationSuccessTest()
  await runOwnerProtectionTest()
  console.log('revokeStaffAccess tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

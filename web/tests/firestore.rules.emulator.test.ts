import { beforeAll, afterAll, describe, test } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  getFirestore,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore'
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  signOut,
  type Auth,
} from 'firebase/auth'

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-sedifex'
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'

const [firestoreAddress, firestorePortRaw] = firestoreHost.split(':')
const firestorePort = Number(firestorePortRaw ?? '8080')
const authBaseUrl = `http://${authHost}`

interface TestContext {
  app: FirebaseApp
  db: Firestore
  auth: Auth | null
}

function createBaseApp(name: string): TestContext {
  const app = initializeApp(
    {
      projectId,
      apiKey: 'fake-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
    },
    name,
  )

  const db = getFirestore(app)
  connectFirestoreEmulator(db, firestoreAddress, firestorePort)

  const auth = getAuth(app)
  connectAuthEmulator(auth, authBaseUrl, { disableWarnings: true })

  return { app, db, auth }
}

async function createStoreMember(storeId: string, role: 'owner' | 'staff' = 'owner'): Promise<TestContext> {
  const context = createBaseApp(`store-member-${storeId}-${Math.random().toString(36).slice(2)}`)
  await signInAnonymously(context.auth)
  const user = context.auth.currentUser
  if (!user) throw new Error('Anonymous sign-in failed for store member test context')

  if (role === 'owner') {
    await setDoc(doc(context.db, 'teamMembers', user.uid), {
      uid: user.uid,
      storeId,
      role,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
  } else {
    const ownerContext = await createStoreMember(storeId, 'owner')
    try {
      await setDoc(doc(ownerContext.db, 'teamMembers', user.uid), {
        uid: user.uid,
        storeId,
        role,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    } finally {
      await destroyContext(ownerContext)
    }
  }

  await user.getIdToken(true)
  return context
}

async function createAuthedWithoutStore(): Promise<TestContext> {
  const context = createBaseApp(`no-store-${Math.random().toString(36).slice(2)}`)
  await signInAnonymously(context.auth)
  const user = context.auth.currentUser
  if (!user) throw new Error('Anonymous sign-in failed for auth-without-store test context')
  await user.getIdToken(true)
  return context
}

async function createUnauthenticated(): Promise<TestContext> {
  const context = createBaseApp(`unauth-${Math.random().toString(36).slice(2)}`)
  await signOut(context.auth).catch(() => {})
  return { ...context, auth: null }
}

async function destroyContext(context: TestContext) {
  if (context.auth) {
    await signOut(context.auth).catch(() => {})
  }
  await deleteApp(context.app)
}

async function expectSucceeds<T>(promise: Promise<T>, message: string) {
  try {
    await promise
  } catch (error) {
    throw new Error(`${message} - expected success, but received error: ${String(error)}`)
  }
}

async function expectFails<T>(promise: Promise<T>, message: string) {
  try {
    await promise
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined
    if (code === 'permission-denied') return
    throw new Error(`${message} - expected permission error, received: ${String(error)}`)
  }
  throw new Error(`${message} - expected permission error, but operation succeeded`)
}

beforeAll(async () => {
  const seedingContext = await createStoreMember('store-1')
  try {
    await setDoc(doc(seedingContext.db, 'stores/store-1'), { name: 'Demo Store' })
    await setDoc(doc(seedingContext.db, 'stores/store-1/inventory/item-1'), { sku: 'sku-1', quantity: 5 })
  } finally {
    await destroyContext(seedingContext)
  }
})

afterAll(async () => {
  // Explicit no-op to keep Vitest happy when using only beforeAll in this suite.
})

describe('Firestore rules - multi-tenant store access', () => {
  test('matching storeId users can read and write their store document', async () => {
    const context = await createStoreMember('store-1')
    try {
      await expectSucceeds(getDoc(doc(context.db, 'stores/store-1')), 'store-1 user should read own store document')
      await expectSucceeds(
        setDoc(doc(context.db, 'stores/store-1'), { name: 'Updated Store' }),
        'store-1 user should write own store document',
      )
    } finally {
      await destroyContext(context)
    }
  })

  test('mismatched storeId users cannot access another store document', async () => {
    const context = await createStoreMember('store-2')
    try {
      await expectFails(getDoc(doc(context.db, 'stores/store-1')), 'store-2 user should be blocked from reading store-1')
      await expectFails(
        setDoc(doc(context.db, 'stores/store-1'), { name: 'Should Fail' }),
        'store-2 user should be blocked from writing store-1',
      )
    } finally {
      await destroyContext(context)
    }
  })

  test('subcollection access is limited to matching storeId users', async () => {
    const allowed = await createStoreMember('store-1')
    const denied = await createStoreMember('store-2')
    try {
      await expectSucceeds(
        setDoc(doc(allowed.db, 'stores/store-1/inventory/item-2'), { sku: 'sku-2', quantity: 3 }),
        'store-1 user should create inventory item for their store',
      )
      await expectFails(
        getDoc(doc(denied.db, 'stores/store-1/inventory/item-1')),
        'store-2 user should be blocked from reading store-1 inventory',
      )
      await expectFails(
        setDoc(doc(denied.db, 'stores/store-1/orders/order-1'), { total: 42 }),
        'store-2 user should be blocked from writing store-1 order',
      )
    } finally {
      await destroyContext(allowed)
      await destroyContext(denied)
    }
  })

  test('authenticated users without a storeId claim are rejected', async () => {
    const context = await createAuthedWithoutStore()
    try {
      await expectFails(getDoc(doc(context.db, 'stores/store-1')), 'users without storeId claim should be denied')
    } finally {
      await destroyContext(context)
    }
  })

  test('unauthenticated requests are rejected', async () => {
    const context = await createUnauthenticated()
    try {
      await expectFails(getDoc(doc(context.db, 'stores/store-1')), 'unauthenticated requests should be denied')
    } finally {
      await destroyContext(context)
    }
  })

  test('sales writes must target the member store and include a storeId', async () => {
    const context = await createStoreMember('store-1', 'staff')
    try {
      const saleRef = doc(context.db, 'sales/sale-1')
      await expectFails(
        setDoc(saleRef, { total: 10, storeId: 'store-2' }),
        'staff should not create sales for another store',
      )
      await expectFails(
        setDoc(saleRef, { total: 10 }),
        'staff should not create sales without storeId',
      )
      await expectSucceeds(
        setDoc(saleRef, { total: 10, storeId: 'store-1' }),
        'staff should create sales for their store',
      )
    } finally {
      await destroyContext(context)
    }
  })

  test('product updates are limited to the member store', async () => {
    const owner = await createStoreMember('store-1', 'owner')
    try {
      const productRef = doc(owner.db, 'products/product-1')
      await expectSucceeds(
        setDoc(productRef, { name: 'Example', price: 1, storeId: 'store-1' }),
        'owners can seed products for their store',
      )
    } finally {
      await destroyContext(owner)
    }

    const staff = await createStoreMember('store-1', 'staff')
    const outsider = await createStoreMember('store-2', 'staff')

    try {
      await expectSucceeds(
        setDoc(doc(staff.db, 'products/product-1'), { name: 'Updated', price: 2, storeId: 'store-1' }),
        'staff can update products for their store',
      )
      await expectFails(
        setDoc(doc(outsider.db, 'products/product-1'), { name: 'Hijack', price: 2, storeId: 'store-1' }),
        'staff from another store cannot update products',
      )
    } finally {
      await destroyContext(staff)
      await destroyContext(outsider)
    }
  })
})

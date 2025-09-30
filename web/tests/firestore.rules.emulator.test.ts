import { beforeAll, afterAll, describe, test } from 'vitest'
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  type Firestore,
  where,
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
const shouldRunEmulatorSuite = process.env.RUN_FIRESTORE_EMULATOR_TESTS === '1'

const [firestoreAddress, firestorePortRaw] = firestoreHost.split(':')
const firestorePort = Number(firestorePortRaw ?? '8080')
const authBaseUrl = `http://${authHost}`
const firestoreRestBaseUrl = `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)`

function encodeFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null }
  if (value instanceof Date) return { timestampValue: value.toISOString() }

  switch (typeof value) {
    case 'string':
      return { stringValue: value }
    case 'number':
      return Number.isInteger(value)
        ? { integerValue: value.toString() }
        : { doubleValue: value }
    case 'boolean':
      return { booleanValue: value }
    case 'object':
      if (Array.isArray(value)) {
        return { arrayValue: { values: value.map(encodeFirestoreValue) } }
      }

      return { mapValue: { fields: encodeFirestoreFields(value as Record<string, unknown>) } }
    default:
      throw new Error(`Unsupported Firestore value type: ${typeof value}`)
  }
}

function encodeFirestoreFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.entries(data).reduce<Record<string, unknown>>((acc, [key, value]) => {
    acc[key] = encodeFirestoreValue(value)
    return acc
  }, {})
}

async function seedDocument(path: string, data: Record<string, unknown>) {
  const response = await fetch(`${firestoreRestBaseUrl}/documents:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `projects/${projectId}/databases/(default)/documents/${path}`,
            fields: encodeFirestoreFields(data),
          },
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to seed document at ${path}: ${response.status} ${text}`)
  }
}

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
  if (!shouldRunEmulatorSuite) {
    return
  }

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

const describeOrSkip = shouldRunEmulatorSuite ? describe : describe.skip

describeOrSkip('Firestore rules - multi-tenant store access', () => {
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
    const outsider = await createStoreMember('store-2', 'staff')
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
      await expectFails(
        setDoc(doc(outsider.db, 'sales/sale-1'), { total: 12, storeId: 'store-1' }),
        'other store staff should not create sales for store-1',
      )
    } finally {
      await destroyContext(context)
      await destroyContext(outsider)
    }
  })

  test('staff can manage customers for their store while preventing cross-store access', async () => {
    const staff = await createStoreMember('store-1', 'staff')
    const outsider = await createStoreMember('store-2', 'staff')

    try {
      const customerRef = doc(staff.db, 'customers/customer-1')
      await expectSucceeds(
        setDoc(customerRef, { name: 'Customer One', storeId: 'store-1' }),
        'staff should create customers for their own store',
      )
      await expectSucceeds(
        setDoc(customerRef, { name: 'Customer Updated', storeId: 'store-1' }),
        'staff should update customers for their store',
      )
      await expectFails(
        setDoc(customerRef, { name: 'Customer Hijack', storeId: 'store-2' }),
        'staff should not move customers to another store',
      )
      await expectSucceeds(getDoc(customerRef), 'staff should read customers in their store')
      await expectFails(
        getDoc(doc(outsider.db, 'customers/customer-1')),
        'other store staff should not read store-1 customers',
      )
      await expectFails(
        deleteDoc(customerRef),
        'staff should not delete customers',
      )
    } finally {
      await destroyContext(staff)
      await destroyContext(outsider)
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
    try {
      await expectFails(
        setDoc(doc(staff.db, 'products/product-1'), { name: 'Updated', price: 2, storeId: 'store-1' }),
        'staff should not update products even for their store',
      )
    } finally {
      await destroyContext(staff)
    }

    const outsider = await createStoreMember('store-2', 'owner')
    try {
      await expectFails(
        setDoc(doc(outsider.db, 'products/product-1'), { name: 'Hijack', price: 2, storeId: 'store-1' }),
        'owners from another store cannot update products',
      )
    } finally {
      await destroyContext(outsider)
    }
  })

  test('ledger updates require owner role and matching store', async () => {
    const owner = await createStoreMember('store-1', 'owner')
    try {
      await expectSucceeds(
        setDoc(doc(owner.db, 'ledger/entry-1'), { storeId: 'store-1', amount: 100 }),
        'owners can write ledger entries for their store',
      )
    } finally {
      await destroyContext(owner)
    }

    const staff = await createStoreMember('store-1', 'staff')
    try {
      await expectFails(
        setDoc(doc(staff.db, 'ledger/entry-1'), { storeId: 'store-1', amount: 100 }),
        'staff should not write ledger entries',
      )
    } finally {
      await destroyContext(staff)
    }

    const outsider = await createStoreMember('store-2', 'owner')
    try {
      await expectFails(
        setDoc(doc(outsider.db, 'ledger/entry-1'), { storeId: 'store-1', amount: 100 }),
        'owners from another store should not write ledger entries',
      )
    } finally {
      await destroyContext(outsider)
    }
  })

  test('stock updates require owner role and matching store', async () => {
    const owner = await createStoreMember('store-1', 'owner')
    try {
      await expectSucceeds(
        setDoc(doc(owner.db, 'stock/item-1'), { storeId: 'store-1', quantity: 5 }),
        'owners can write stock records for their store',
      )
    } finally {
      await destroyContext(owner)
    }

    const staff = await createStoreMember('store-1', 'staff')
    try {
      await expectFails(
        setDoc(doc(staff.db, 'stock/item-1'), { storeId: 'store-1', quantity: 5 }),
        'staff should not write stock records',
      )
    } finally {
      await destroyContext(staff)
    }

    const outsider = await createStoreMember('store-2', 'owner')
    try {
      await expectFails(
        setDoc(doc(outsider.db, 'stock/item-1'), { storeId: 'store-1', quantity: 5 }),
        'owners from another store should not write stock records',
      )
    } finally {
      await destroyContext(outsider)
    }
  })

  test('staff can write sales related records while outsiders are blocked', async () => {
    const staff = await createStoreMember('store-1', 'staff')
    const outsider = await createStoreMember('store-2', 'staff')
    try {
      await expectSucceeds(
        setDoc(doc(staff.db, 'saleItems/sale-1_item-1'), { storeId: 'store-1', saleId: 'sale-1', price: 5 }),
        'staff can write sale items for their store',
      )
      await expectSucceeds(
        setDoc(doc(staff.db, 'receipts/receipt-1'), { storeId: 'store-1', total: 20 }),
        'staff can write receipts for their store',
      )
      await expectSucceeds(
        setDoc(doc(staff.db, 'customers/customer-1'), { storeId: 'store-1', name: 'Alice' }),
        'staff can write customers for their store',
      )

      await expectFails(
        setDoc(doc(outsider.db, 'saleItems/sale-1_item-1'), { storeId: 'store-1', saleId: 'sale-1', price: 5 }),
        'other store staff should not write sale items for store-1',
      )
      await expectFails(
        setDoc(doc(outsider.db, 'receipts/receipt-1'), { storeId: 'store-1', total: 20 }),
        'other store staff should not write receipts for store-1',
      )
      await expectFails(
        setDoc(doc(outsider.db, 'customers/customer-1'), { storeId: 'store-1', name: 'Alice' }),
        'other store staff should not write customers for store-1',
      )
    } finally {
      await destroyContext(staff)
      await destroyContext(outsider)
    }
  })

  test('staff can create receipts for their store and cannot see other stores', async () => {
    const staff = await createStoreMember('store-1', 'staff')
    const outsider = await createStoreMember('store-2', 'staff')

    try {
      const receiptRef = doc(staff.db, 'receipts/receipt-1')
      await expectSucceeds(
        setDoc(receiptRef, {
          storeId: 'store-1',
          productId: 'product-1',
          qty: 3,
        }),
        'staff should create receipts for their store',
      )
      await expectSucceeds(getDoc(receiptRef), 'staff should read receipts for their store')
      await expectFails(
        setDoc(doc(staff.db, 'receipts/receipt-2'), {
          storeId: 'store-2',
          productId: 'product-2',
          qty: 1,
        }),
        'staff should not create receipts for another store',
      )
      await expectFails(
        getDoc(doc(outsider.db, 'receipts/receipt-1')),
        'other store staff should not read store-1 receipts',
      )
    } finally {
      await destroyContext(staff)
      await destroyContext(outsider)
    }
  })

  test('store members can read daily summaries for their store but cannot write them', async () => {
    await seedDocument('dailySummaries/store-1_2024-09-01', {
      storeId: 'store-1',
      dateKey: '2024-09-01',
      salesTotal: 123.45,
    })

    const allowed = await createStoreMember('store-1', 'staff')
    try {
      await expectSucceeds(
        getDoc(doc(allowed.db, 'dailySummaries/store-1_2024-09-01')),
        'store member should read their daily summary',
      )
      await expectFails(
        setDoc(doc(allowed.db, 'dailySummaries/store-1_2024-09-02'), {
          storeId: 'store-1',
          dateKey: '2024-09-02',
        }),
        'store member should not create a new daily summary document',
      )
    } finally {
      await destroyContext(allowed)
    }

    const outsider = await createStoreMember('store-2', 'staff')
    try {
      await expectFails(
        getDoc(doc(outsider.db, 'dailySummaries/store-1_2024-09-01')),
        'other store members should not read store-1 summaries',
      )
    } finally {
      await destroyContext(outsider)
    }
  })

  test('store members can read their activity feed but cannot write entries', async () => {
    await seedDocument('activities/activity-1', {
      storeId: 'store-1',
      dateKey: '2024-09-01',
      type: 'sale',
      summary: 'Recorded a sale',
      at: new Date('2024-09-01T10:00:00.000Z'),
    })

    const allowed = await createStoreMember('store-1', 'staff')
    try {
      await expectSucceeds(
        getDocs(query(collection(allowed.db, 'activities'), where('storeId', '==', 'store-1'))),
        'store member should list their store activities',
      )
      await expectFails(
        setDoc(doc(allowed.db, 'activities/new-activity'), {
          storeId: 'store-1',
          dateKey: '2024-09-01',
          type: 'manual',
        }),
        'store member should not create activity entries',
      )
    } finally {
      await destroyContext(allowed)
    }

    const outsider = await createStoreMember('store-2', 'staff')
    try {
      await expectFails(
        getDocs(query(collection(outsider.db, 'activities'), where('storeId', '==', 'store-1'))),
        'store-2 member should not list store-1 activities',
      )
    } finally {
      await destroyContext(outsider)
    }
  })
})

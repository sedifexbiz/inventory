import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
admin.initializeApp()
const db = admin.firestore()

type StoreUserDoc = {
  storeId: string
  uid: string
  role: string
  email?: string
}

type StoreClaims = {
  stores: string[]
  activeStoreId: string | null
  roleByStore: Record<string, string>
}

async function listStoreMemberships(uid: string) {
  const snapshot = await db.collection('storeUsers').where('uid', '==', uid).get()
  return snapshot.docs
    .map(doc => ({ id: doc.id, ...(doc.data() as StoreUserDoc) }))
    .filter(doc => typeof doc.storeId === 'string' && typeof doc.role === 'string')
}

async function applyStoreClaims(uid: string): Promise<StoreClaims> {
  const [memberships, userRecord] = await Promise.all([
    listStoreMemberships(uid),
    admin
      .auth()
      .getUser(uid)
      .catch(() => null),
  ])

  const stores = Array.from(
    new Set(memberships.map(membership => membership.storeId).filter(Boolean)),
  )

  const roleByStore = memberships.reduce<Record<string, string>>((acc, membership) => {
    if (membership.storeId && membership.role) {
      acc[membership.storeId] = membership.role
    }
    return acc
  }, {})

  const existingClaims = (userRecord?.customClaims ?? {}) as Record<string, unknown>
  const preferredActive = typeof existingClaims.activeStoreId === 'string' ? existingClaims.activeStoreId : null
  let activeStoreId: string | null = preferredActive && stores.includes(preferredActive) ? preferredActive : null
  if (!activeStoreId) {
    activeStoreId = stores.length > 0 ? stores[0] : null
  }

  const nextClaims = {
    ...existingClaims,
    stores,
    activeStoreId,
    roleByStore,
  }

  await admin.auth().setCustomUserClaims(uid, nextClaims)

  return { stores, activeStoreId, roleByStore }
}

async function ensureDefaultStoreForUser(uid: string, email?: string | null) {
  const existingMemberships = await listStoreMemberships(uid)
  if (existingMemberships.length > 0) {
    return
  }

  const anyMembership = await db.collection('storeUsers').limit(1).get()
  if (!anyMembership.empty) {
    return
  }

  const storeId = uid
  const storeRef = db.collection('stores').doc(storeId)
  const membershipId = `${storeId}_${uid}`
  const membershipRef = db.collection('storeUsers').doc(membershipId)

  await db.runTransaction(async tx => {
    const membershipSnap = await tx.get(membershipRef)
    if (membershipSnap.exists) {
      return
    }

    tx.set(storeRef, {
      storeId,
      ownerId: uid,
      ownerEmail: email ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    tx.set(membershipRef, {
      storeId,
      uid,
      role: 'owner',
      email: email ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  })
}

async function refreshUserClaims(uid: string, email?: string | null) {
  await ensureDefaultStoreForUser(uid, email)
  return applyStoreClaims(uid)
}

export const handleUserCreate = functions.auth.user().onCreate(async user => {
  const uid = user.uid
  const email = user.email ?? null
  await refreshUserClaims(uid, email)
})

export const initializeStore = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required')
  }

  const uid = context.auth.uid
  const email = typeof context.auth.token.email === 'string' ? context.auth.token.email : null

  const claims = await refreshUserClaims(uid, email)
  return { ok: true, claims }
})

type ManageStaffPayload = {
  storeId?: unknown
  email?: unknown
  role?: unknown
  password?: unknown
}

function assertOwnerAccess(context: functions.https.CallableContext, storeId: string) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required')
  }

  const claims = context.auth.token as Record<string, unknown>
  const stores = Array.isArray(claims.stores) ? claims.stores : []
  if (!stores.includes(storeId)) {
    throw new functions.https.HttpsError('permission-denied', 'No store access')
  }

  const roleByStore = (claims.roleByStore ?? {}) as Record<string, unknown>
  const role = typeof roleByStore[storeId] === 'string' ? roleByStore[storeId] : null
  if (role !== 'owner') {
    throw new functions.https.HttpsError('permission-denied', 'Owner access required')
  }
}

function normalizeManageStaffPayload(data: ManageStaffPayload) {
  const storeId = typeof data.storeId === 'string' ? data.storeId.trim() : ''
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
  const role = typeof data.role === 'string' ? data.role.trim() : ''
  const passwordRaw = data.password
  let password: string | undefined
  if (passwordRaw === null || passwordRaw === undefined || passwordRaw === '') {
    password = undefined
  } else if (typeof passwordRaw === 'string') {
    password = passwordRaw
  } else {
    throw new functions.https.HttpsError('invalid-argument', 'Password must be a string when provided')
  }

  if (!storeId) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid storeId is required')
  }
  if (!email) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid email is required')
  }
  if (!role) {
    throw new functions.https.HttpsError('invalid-argument', 'A role is required')
  }

  return { storeId, email, role, password }
}

async function ensureAuthUser(email: string, password?: string) {
  try {
    const record = await admin.auth().getUserByEmail(email)
    if (password) {
      await admin.auth().updateUser(record.uid, { password })
    }
    return { record, created: false }
  } catch (error: any) {
    if (error?.code === 'auth/user-not-found') {
      if (!password) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'A password is required when creating a new staff account',
        )
      }

      const record = await admin.auth().createUser({ email, password, emailVerified: false })
      return { record, created: true }
    }
    throw error
  }
}

async function upsertStoreMembership(
  storeId: string,
  uid: string,
  email: string,
  role: string,
  invitedBy: string | null,
) {
  const membershipRef = db.collection('storeUsers').doc(`${storeId}_${uid}`)
  const snapshot = await membershipRef.get()
  const timestamp = admin.firestore.FieldValue.serverTimestamp()

  const data = {
    storeId,
    uid,
    email,
    role,
    invitedBy,
    updatedAt: timestamp,
    ...(snapshot.exists ? {} : { createdAt: timestamp }),
  }

  await membershipRef.set(data, { merge: true })
  return data
}

export const manageStaffAccount = functions.https.onCall(async (data, context) => {
  const { storeId, email, role, password } = normalizeManageStaffPayload(data as ManageStaffPayload)
  assertOwnerAccess(context, storeId)

  const invitedBy = context.auth?.uid ?? null
  const { record, created } = await ensureAuthUser(email, password)

  await upsertStoreMembership(storeId, record.uid, email, role, invitedBy)
  const claims = await applyStoreClaims(record.uid)

  return {
    ok: true,
    storeId,
    role,
    email,
    uid: record.uid,
    created,
    claims,
  }
})

export const commitSale = functions.https.onCall(async (data, context) => {
  const { storeId, branchId, items, totals, cashierId, saleId, payment, customer } = data || {}
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required')
  const claims = context.auth.token as any
  if (!claims?.stores?.includes?.(storeId)) throw new functions.https.HttpsError('permission-denied', 'No store access')

  const saleRef = db.collection('sales').doc(saleId)
  const saleItemsRef = db.collection('saleItems')

  await db.runTransaction(async (tx) => {
    const normalizedItems = Array.isArray(items)
      ? items.map((it: any) => {
          const productId = typeof it?.productId === 'string' ? it.productId : null
          const name = typeof it?.name === 'string' ? it.name : null
          const qty = Number(it?.qty ?? 0) || 0
          const price = Number(it?.price ?? 0) || 0
          const taxRate = Number(it?.taxRate ?? 0) || 0
          return { productId, name, qty, price, taxRate }
        })
      : []

    tx.set(saleRef, {
      storeId,
      branchId: branchId ?? null,
      cashierId,
      total: totals?.total ?? 0,
      taxTotal: totals?.taxTotal ?? 0,
      payment: payment ?? null,
      customer: customer ?? null,
      items: normalizedItems,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    })

    for (const it of normalizedItems) {
      if (!it.productId) {
        throw new functions.https.HttpsError('failed-precondition', 'Bad product')
      }
      const itemId = db.collection('_').doc().id
      tx.set(saleItemsRef.doc(itemId), {
        storeId, saleId, productId: it.productId, qty: it.qty, price: it.price, taxRate: it.taxRate
      })

      const pRef = db.collection('products').doc(it.productId)
      const pSnap = await tx.get(pRef)
      if (!pSnap.exists || pSnap.get('storeId') !== storeId) {
        throw new functions.https.HttpsError('failed-precondition', 'Bad product')
      }
      const curr = pSnap.get('stockCount') || 0
      const next = curr - Math.abs(it.qty || 0)
      tx.update(pRef, { stockCount: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() })

      const ledgerId = db.collection('_').doc().id
      tx.set(db.collection('ledger').doc(ledgerId), {
        storeId, branchId, productId: it.productId, qtyChange: -Math.abs(it.qty || 0),
        type: 'sale', refId: saleId, createdAt: admin.firestore.FieldValue.serverTimestamp()
      })
    }
  })

  return { ok: true, saleId }
})

export const receiveStock = functions.https.onCall(async (data, context) => {
  const { storeId, productId, qty, supplier, reference, unitCost } = data || {}
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login required')
  const claims = context.auth.token as any
  if (!claims?.stores?.includes?.(storeId)) {
    throw new functions.https.HttpsError('permission-denied', 'No store access')
  }

  const productIdStr = typeof productId === 'string' ? productId : null
  if (!productIdStr) {
    throw new functions.https.HttpsError('invalid-argument', 'A product must be selected')
  }

  const amount = Number(qty)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Quantity must be greater than zero')
  }

  const normalizedSupplier = typeof supplier === 'string' ? supplier.trim() : ''
  if (!normalizedSupplier) {
    throw new functions.https.HttpsError('invalid-argument', 'Supplier is required')
  }

  const normalizedReference = typeof reference === 'string' ? reference.trim() : ''
  if (!normalizedReference) {
    throw new functions.https.HttpsError('invalid-argument', 'Reference number is required')
  }

  let normalizedUnitCost: number | null = null
  if (unitCost !== undefined && unitCost !== null && unitCost !== '') {
    const parsedCost = Number(unitCost)
    if (!Number.isFinite(parsedCost) || parsedCost < 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Cost must be zero or greater when provided')
    }
    normalizedUnitCost = parsedCost
  }

  const productRef = db.collection('products').doc(productIdStr)
  const receiptRef = db.collection('receipts').doc()
  const ledgerRef = db.collection('ledger').doc()

  await db.runTransaction(async (tx) => {
    const pSnap = await tx.get(productRef)
    if (!pSnap.exists || pSnap.get('storeId') !== storeId) {
      throw new functions.https.HttpsError('failed-precondition', 'Bad product')
    }

    const currentStock = Number(pSnap.get('stockCount') || 0)
    const nextStock = currentStock + amount
    const timestamp = admin.firestore.FieldValue.serverTimestamp()

    tx.update(productRef, {
      stockCount: nextStock,
      updatedAt: timestamp,
      lastReceivedAt: timestamp,
      lastReceivedQty: amount,
      lastReceivedCost: normalizedUnitCost
    })

    const totalCost =
      normalizedUnitCost === null ? null : Math.round((normalizedUnitCost * amount + Number.EPSILON) * 100) / 100

    tx.set(receiptRef, {
      storeId,
      productId: productIdStr,
      qty: amount,
      supplier: normalizedSupplier,
      reference: normalizedReference,
      unitCost: normalizedUnitCost,
      totalCost,
      receivedBy: context.auth?.uid ?? null,
      createdAt: timestamp
    })

    tx.set(ledgerRef, {
      storeId,
      productId: productIdStr,
      qtyChange: amount,
      type: 'receipt',
      refId: receiptRef.id,
      createdAt: timestamp
    })
  })

  return { ok: true, receiptId: receiptRef.id }
})

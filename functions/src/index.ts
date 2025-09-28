import * as functions from 'firebase-functions'
import { admin, defaultDb, rosterDb } from './firestore'

const db = defaultDb

type ContactPayload = {
  phone?: unknown
  firstSignupEmail?: unknown
}

type InitializeStorePayload = {
  contact?: ContactPayload
}

type ResolveStoreAccessPayload = {
  contact?: ContactPayload
}

type ManageStaffPayload = {
  storeId?: unknown
  email?: unknown
  role?: unknown
  password?: unknown
}

const VALID_ROLES = new Set(['owner', 'staff'])

function normalizeContactPayload(contact: ContactPayload | undefined) {
  let hasPhone = false
  let hasFirstSignupEmail = false
  let phone: string | null | undefined
  let firstSignupEmail: string | null | undefined

  if (contact && typeof contact === 'object') {
    if ('phone' in contact) {
      hasPhone = true
      const raw = contact.phone
      if (raw === null || raw === undefined || raw === '') {
        phone = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        phone = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError('invalid-argument', 'Phone must be a string when provided')
      }
    }

    if ('firstSignupEmail' in contact) {
      hasFirstSignupEmail = true
      const raw = contact.firstSignupEmail
      if (raw === null || raw === undefined || raw === '') {
        firstSignupEmail = null
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim().toLowerCase()
        firstSignupEmail = trimmed ? trimmed : null
      } else {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'First signup email must be a string when provided',
        )
      }
    }
  }

  return { phone, hasPhone, firstSignupEmail, hasFirstSignupEmail }
}

function getRoleFromToken(token: Record<string, unknown> | undefined) {
  const role = typeof token?.role === 'string' ? (token.role as string) : null
  return role && VALID_ROLES.has(role) ? role : null
}

function assertAuthenticated(context: functions.https.CallableContext) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required')
  }
}

function assertOwnerAccess(context: functions.https.CallableContext) {
  assertAuthenticated(context)
  const role = getRoleFromToken(context.auth!.token as Record<string, unknown>)
  if (role !== 'owner') {
    throw new functions.https.HttpsError('permission-denied', 'Owner access required')
  }
}

function assertStaffAccess(context: functions.https.CallableContext) {
  assertAuthenticated(context)
  const role = getRoleFromToken(context.auth!.token as Record<string, unknown>)
  if (!role) {
    throw new functions.https.HttpsError('permission-denied', 'Staff access required')
  }
}

async function updateUserClaims(uid: string, role: string) {
  const userRecord = await admin
    .auth()
    .getUser(uid)
    .catch(() => null)
  const existingClaims = (userRecord?.customClaims ?? {}) as Record<string, unknown>
  const nextClaims: Record<string, unknown> = { ...existingClaims }
  nextClaims.role = role
  delete nextClaims.stores
  delete nextClaims.activeStoreId
  delete nextClaims.storeId
  delete nextClaims.roleByStore
  await admin.auth().setCustomUserClaims(uid, nextClaims)
  return nextClaims
}

function normalizeManageStaffPayload(data: ManageStaffPayload) {
  const storeIdRaw = data.storeId
  const storeId = typeof storeIdRaw === 'string' ? storeIdRaw.trim() : ''
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

  if (!storeId) throw new functions.https.HttpsError('invalid-argument', 'A storeId is required')
  if (!email) throw new functions.https.HttpsError('invalid-argument', 'A valid email is required')
  if (!role) throw new functions.https.HttpsError('invalid-argument', 'A role is required')
  if (!VALID_ROLES.has(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Unsupported role requested')
  }

  return { storeId, email, role, password }
}

async function ensureAuthUser(email: string, password?: string) {
  try {
    const record = await admin.auth().getUserByEmail(email)
    if (password) await admin.auth().updateUser(record.uid, { password })
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

export const handleUserCreate = functions.auth.user().onCreate(async user => {
  const uid = user.uid
  const timestamp = admin.firestore.FieldValue.serverTimestamp()
  await rosterDb
    .collection('teamMembers')
    .doc(uid)
    .set(
      {
        uid,
        email: user.email ?? null,
        phone: user.phoneNumber ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { merge: true },
    )
})

export const initializeStore = functions.https.onCall(async (data, context) => {
  assertAuthenticated(context)

  const uid = context.auth!.uid
  const token = context.auth!.token as Record<string, unknown>
  const email = typeof token.email === 'string' ? (token.email as string) : null
  const tokenPhone = typeof token.phone_number === 'string' ? (token.phone_number as string) : null

  const payload = (data ?? {}) as InitializeStorePayload
  const contact = normalizeContactPayload(payload.contact)
  const resolvedPhone = contact.hasPhone ? contact.phone ?? null : tokenPhone ?? null
  const resolvedFirstSignupEmail = contact.hasFirstSignupEmail
    ? contact.firstSignupEmail ?? null
    : email?.toLowerCase() ?? null

  const memberRef = rosterDb.collection('teamMembers').doc(uid)
  const memberSnap = await memberRef.get()
  const timestamp = admin.firestore.FieldValue.serverTimestamp()
  const existingData = memberSnap.data() ?? {}
  const existingStoreId =
    typeof existingData.storeId === 'string' && existingData.storeId.trim() !== ''
      ? (existingData.storeId as string)
      : null
  const storeId = existingStoreId ?? uid

  const memberData: admin.firestore.DocumentData = {
    uid,
    email,
    role: 'owner',
    storeId,
    phone: resolvedPhone,
    firstSignupEmail: resolvedFirstSignupEmail,
    invitedBy: uid,
    updatedAt: timestamp,
  }

  if (!memberSnap.exists) {
    memberData.createdAt = timestamp
  }

  await memberRef.set(memberData, { merge: true })
  const claims = await updateUserClaims(uid, 'owner')

  return { ok: true, claims, storeId }
})

export const resolveStoreAccess = functions.https.onCall(async (data, context) => {
  assertAuthenticated(context)

  const uid = context.auth!.uid
  const token = context.auth!.token as Record<string, unknown>
  const email = typeof token.email === 'string' ? (token.email as string) : null
  const tokenPhone = typeof token.phone_number === 'string' ? (token.phone_number as string) : null

  const memberRef = rosterDb.collection('teamMembers').doc(uid)
  const memberSnap = await memberRef.get()
  if (!memberSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'No team membership found for this account')
  }

  const memberData = memberSnap.data() ?? {}
  const roleRaw = typeof memberData.role === 'string' ? (memberData.role as string) : ''
  if (!VALID_ROLES.has(roleRaw)) {
    throw new functions.https.HttpsError('failed-precondition', 'This account does not have workspace access yet')
  }
  const existingStoreId =
    typeof memberData.storeId === 'string' && memberData.storeId.trim() !== ''
      ? (memberData.storeId as string)
      : null
  const storeId = existingStoreId ?? uid

  const payload = (data ?? {}) as ResolveStoreAccessPayload
  const contact = normalizeContactPayload(payload.contact)
  const resolvedPhone = contact.hasPhone ? contact.phone ?? null : tokenPhone ?? null
  const resolvedFirstSignupEmail = contact.hasFirstSignupEmail
    ? contact.firstSignupEmail ?? null
    : email?.toLowerCase() ?? null

  const updates: admin.firestore.DocumentData = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }
  if (!existingStoreId) {
    updates.storeId = storeId
  }
  if (contact.hasPhone) {
    updates.phone = resolvedPhone
  }
  if (contact.hasFirstSignupEmail) {
    updates.firstSignupEmail = resolvedFirstSignupEmail
  }
  if (Object.keys(updates).length > 1) {
    await memberRef.set(updates, { merge: true })
  }

  const claims = await updateUserClaims(uid, roleRaw)
  return { ok: true, role: roleRaw, claims, storeId }
})

export const manageStaffAccount = functions.https.onCall(async (data, context) => {
  assertOwnerAccess(context)

  const { storeId, email, role, password } = normalizeManageStaffPayload(data as ManageStaffPayload)
  const invitedBy = context.auth?.uid ?? null
  const { record, created } = await ensureAuthUser(email, password)

  const memberRef = rosterDb.collection('teamMembers').doc(record.uid)
  const memberSnap = await memberRef.get()
  const timestamp = admin.firestore.FieldValue.serverTimestamp()

  const memberData: admin.firestore.DocumentData = {
    uid: record.uid,
    email,
    storeId,
    role,
    invitedBy,
    updatedAt: timestamp,
  }

  if (!memberSnap.exists) {
    memberData.createdAt = timestamp
  }

  await memberRef.set(memberData, { merge: true })
  const claims = await updateUserClaims(record.uid, role)

  return { ok: true, role, email, uid: record.uid, created, storeId, claims }
})

export const commitSale = functions.https.onCall(async (data, context) => {
  assertStaffAccess(context)

  const { branchId, items, totals, cashierId, saleId: saleIdRaw, payment, customer } = data || {}

  const saleId = typeof saleIdRaw === 'string' ? saleIdRaw.trim() : ''
  if (!saleId) throw new functions.https.HttpsError('invalid-argument', 'A valid saleId is required')

  const normalizedBranchIdRaw = typeof branchId === 'string' ? branchId.trim() : ''
  if (!normalizedBranchIdRaw) {
    throw new functions.https.HttpsError('invalid-argument', 'A valid branch identifier is required')
  }
  const normalizedBranchId = normalizedBranchIdRaw

  const saleRef = db.collection('sales').doc(saleId)
  const saleItemsRef = db.collection('saleItems')

  await db.runTransaction(async tx => {
    const existingSale = await tx.get(saleRef)
    if (existingSale.exists) throw new functions.https.HttpsError('already-exists', 'Sale has already been committed')

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

    const timestamp = admin.firestore.FieldValue.serverTimestamp()

    tx.set(saleRef, {
      branchId: normalizedBranchId,
      storeId: normalizedBranchId,
      cashierId,
      total: totals?.total ?? 0,
      taxTotal: totals?.taxTotal ?? 0,
      payment: payment ?? null,
      customer: customer ?? null,
      items: normalizedItems,
      createdBy: context.auth?.uid ?? null,
      createdAt: timestamp,
    })

    for (const it of normalizedItems) {
      if (!it.productId) {
        throw new functions.https.HttpsError('failed-precondition', 'Bad product')
      }
      const itemId = db.collection('_').doc().id
      tx.set(saleItemsRef.doc(itemId), {
        saleId,
        productId: it.productId,
        qty: it.qty,
        price: it.price,
        taxRate: it.taxRate,
        storeId: normalizedBranchId,
        createdAt: timestamp,
      })

      const pRef = db.collection('products').doc(it.productId)
      const pSnap = await tx.get(pRef)
      if (!pSnap.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'Bad product')
      }
      const curr = Number(pSnap.get('stockCount') || 0)
      const next = curr - Math.abs(it.qty || 0)
      tx.update(pRef, { stockCount: next, updatedAt: timestamp })

      const ledgerId = db.collection('_').doc().id
      tx.set(db.collection('ledger').doc(ledgerId), {
        productId: it.productId,
        qtyChange: -Math.abs(it.qty || 0),
        type: 'sale',
        refId: saleId,
        storeId: normalizedBranchId,
        createdAt: timestamp,
      })
    }
  })

  return { ok: true, saleId }
})

export const receiveStock = functions.https.onCall(async (data, context) => {
  assertStaffAccess(context)

  const { productId, qty, supplier, reference, unitCost } = data || {}

  const productIdStr = typeof productId === 'string' ? productId : null
  if (!productIdStr) throw new functions.https.HttpsError('invalid-argument', 'A product must be selected')

  const amount = Number(qty)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Quantity must be greater than zero')
  }

  const normalizedSupplier = typeof supplier === 'string' ? supplier.trim() : ''
  if (!normalizedSupplier) throw new functions.https.HttpsError('invalid-argument', 'Supplier is required')

  const normalizedReference = typeof reference === 'string' ? reference.trim() : ''
  if (!normalizedReference) throw new functions.https.HttpsError('invalid-argument', 'Reference number is required')

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

  await db.runTransaction(async tx => {
    const pSnap = await tx.get(productRef)
    if (!pSnap.exists) {
      throw new functions.https.HttpsError('failed-precondition', 'Bad product')
    }

    const productStoreIdRaw = pSnap.get('storeId')
    const productStoreId = typeof productStoreIdRaw === 'string' ? productStoreIdRaw.trim() : null

    const currentStock = Number(pSnap.get('stockCount') || 0)
    const nextStock = currentStock + amount
    const timestamp = admin.firestore.FieldValue.serverTimestamp()

    tx.update(productRef, {
      stockCount: nextStock,
      updatedAt: timestamp,
      lastReceivedAt: timestamp,
      lastReceivedQty: amount,
      lastReceivedCost: normalizedUnitCost,
    })

    const totalCost =
      normalizedUnitCost === null ? null : Math.round((normalizedUnitCost * amount + Number.EPSILON) * 100) / 100

    tx.set(receiptRef, {
      productId: productIdStr,
      qty: amount,
      supplier: normalizedSupplier,
      reference: normalizedReference,
      unitCost: normalizedUnitCost,
      totalCost,
      receivedBy: context.auth?.uid ?? null,
      createdAt: timestamp,
      storeId: productStoreId,
    })

    tx.set(ledgerRef, {
      productId: productIdStr,
      qtyChange: amount,
      type: 'receipt',
      refId: receiptRef.id,
      storeId: productStoreId,
      createdAt: timestamp,
    })
  })

  return { ok: true, receiptId: receiptRef.id }
})

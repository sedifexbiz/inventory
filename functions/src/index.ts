import * as functions from 'firebase-functions'
import { admin, defaultDb, rosterDb } from './firestore'
import { fetchClientRowByEmail, getDefaultSpreadsheetId, normalizeHeader } from './googleSheets'

const db = defaultDb

type ContactPayload = {
  phone?: unknown
  firstSignupEmail?: unknown
}

type InitializeStorePayload = {
  contact?: ContactPayload
}

type ManageStaffPayload = {
  storeId?: unknown
  email?: unknown
  role?: unknown
  password?: unknown
}

const VALID_ROLES = new Set(['owner', 'staff'])
const INACTIVE_WORKSPACE_MESSAGE =
  'Your Sedifex workspace contract is not active. Reach out to your Sedifex administrator to restore access.'

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

type SheetRecord = Record<string, string>

type SeededDocument = {
  id: string
  data: admin.firestore.DocumentData
}

function getOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return null
}

function getOptionalEmail(value: unknown): string | null {
  const candidate = getOptionalString(value)
  return candidate ? candidate.toLowerCase() : null
}

function getValueFromRecord(record: SheetRecord, keys: string[]): string | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const value = record[normalizedKey]
    const resolved = getOptionalString(value)
    if (resolved) return resolved
  }
  return null
}

function getEmailFromRecord(record: SheetRecord, keys: string[]): string | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const value = record[normalizedKey]
    const resolved = getOptionalEmail(value)
    if (resolved) return resolved
  }
  return null
}

function isInactiveContractStatus(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean)
  const tokenSet = new Set(tokens)
  const inactiveTokens = [
    'inactive',
    'terminated',
    'termination',
    'cancelled',
    'canceled',
    'suspended',
    'paused',
    'hold',
    'closed',
    'ended',
    'deactivated',
    'disabled',
  ]
  return inactiveTokens.some(token => tokenSet.has(token))
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const normalized = trimmed.replace(/[^0-9.+-]/g, '')
    if (!normalized) return null
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseDateValue(value: unknown): admin.firestore.Timestamp | null {
  if (value instanceof admin.firestore.Timestamp) {
    return value
  }

  let candidate: number | null = null

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      candidate = parsed
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000_000_000) {
      candidate = value
    } else if (value > 1_000_000_000) {
      candidate = value * 1000
    } else if (value > 0) {
      const serialEpoch = Date.UTC(1899, 11, 30)
      candidate = serialEpoch + value * 24 * 60 * 60 * 1000
    }
  }

  if (candidate === null) {
    return null
  }

  return admin.firestore.Timestamp.fromMillis(candidate)
}

function getTimestampFromRecord(
  record: SheetRecord,
  keys: string[],
): admin.firestore.Timestamp | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const raw = record[normalizedKey]
    const parsed = parseDateValue(raw)
    if (parsed) return parsed
  }
  return null
}

function getNumberFromRecord(record: SheetRecord, keys: string[]): number | null {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key)
    if (!normalizedKey) continue
    const raw = record[normalizedKey]
    const parsed = parseNumberValue(raw)
    if (parsed !== null) return parsed
  }
  return null
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildSeedId(storeId: string, candidate: string | null, fallback: string): string {
  const normalizedCandidate = candidate ? slugify(candidate) : ''
  if (normalizedCandidate) {
    return `${storeId}_${normalizedCandidate}`
  }
  return `${storeId}_${fallback}`
}

function parseSeedArray(record: SheetRecord, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = getOptionalString(record[key])
    if (!value) continue
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter(item => typeof item === 'object' && item !== null) as Record<string, unknown>[]
      }
      if (parsed && typeof parsed === 'object') {
        return Object.values(parsed as Record<string, unknown>).filter(
          item => typeof item === 'object' && item !== null,
        ) as Record<string, unknown>[]
      }
    } catch (error) {
      functions.logger.warn('[resolveStoreAccess] Unable to parse seed data column', key, error)
    }
  }
  return []
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => getOptionalString(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
  }
  const asString = getOptionalString(value)
  if (!asString) return []
  return asString
    .split(/[,#]/)
    .map(part => part.trim())
    .filter(Boolean)
}

function mapProductSeeds(record: SheetRecord, storeId: string): SeededDocument[] {
  const products = parseSeedArray(record, ['products_json', 'products'])
  return products
    .map((product, index) => {
      const name = getOptionalString(product.name ?? product.product_name ?? product.title)
      if (!name) return null
      const sku = getOptionalString(product.sku ?? product.product_sku ?? product.code)
      const idCandidate =
        getOptionalString(product.id ?? product.product_id ?? product.identifier ?? sku ?? name) ?? null
      const price =
        parseNumberValue(product.price ?? product.unit_price ?? product.retail_price ?? product.cost_price) ?? null
      const stockCount =
        parseNumberValue(product.stockCount ?? product.stock_count ?? product.quantity ?? product.inventory) ?? null
      const reorderThreshold =
        parseNumberValue(
          product.reorderThreshold ?? product.reorder_threshold ?? product.reorder_point ?? product.reorder,
        ) ?? null

      const seedId = buildSeedId(storeId, idCandidate, `product_${index + 1}`)
      const data: admin.firestore.DocumentData = { storeId, name }
      if (sku) data.sku = sku
      if (price !== null) data.price = price
      if (stockCount !== null) data.stockCount = stockCount
      if (reorderThreshold !== null) data.reorderThreshold = reorderThreshold
      return { id: seedId, data }
    })
    .filter((item): item is SeededDocument => item !== null)
}

function mapCustomerSeeds(record: SheetRecord, storeId: string): SeededDocument[] {
  const customers = parseSeedArray(record, ['customers_json', 'customers'])
  return customers
    .map((customer, index) => {
      const primaryName =
        getOptionalString(customer.displayName ?? customer.display_name ?? customer.name ?? customer.customer_name) ??
        null
      const fallbackName =
        getOptionalString(customer.name ?? customer.customer_name ?? customer.displayName ?? customer.display_name) ??
        primaryName
      const email = getOptionalEmail(customer.email ?? customer.contact_email)
      const phone = getOptionalString(customer.phone ?? customer.phone_number ?? customer.contact_phone)

      if (!primaryName && !fallbackName && !email && !phone) {
        return null
      }

      const identifierCandidate =
        getOptionalString(
          customer.id ??
            customer.customer_id ??
            customer.identifier ??
            customer.external_id ??
            email ??
            phone ??
            primaryName ??
            fallbackName ??
            undefined,
        ) ?? null

      const tags = parseTags(customer.tags ?? customer.labels)
      const notes = getOptionalString(customer.notes ?? customer.note ?? customer.summary)

      const seedId = buildSeedId(storeId, identifierCandidate, `customer_${index + 1}`)
      const data: admin.firestore.DocumentData = {
        storeId,
        name: fallbackName ?? primaryName ?? email ?? phone ?? seedId,
      }
      if (primaryName) data.displayName = primaryName
      if (email) data.email = email
      if (phone) data.phone = phone
      if (notes) data.notes = notes
      if (tags.length) data.tags = tags
      return { id: seedId, data }
    })
    .filter((item): item is SeededDocument => item !== null)
}

function serializeFirestoreData(data: admin.firestore.DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof admin.firestore.Timestamp) {
      result[key] = value.toMillis()
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item instanceof admin.firestore.Timestamp ? item.toMillis() : item,
      )
    } else {
      result[key] = value
    }
  }
  return result
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
  const emailFromToken = typeof token.email === 'string' ? (token.email as string).toLowerCase() : null

  const rawPayload = (data ?? {}) as { storeId?: unknown } | unknown
  let requestedStoreId: string | null = null
  if (typeof rawPayload === 'object' && rawPayload !== null && 'storeId' in rawPayload) {
    const candidate = (rawPayload as { storeId?: unknown }).storeId
    if (typeof candidate !== 'string') {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Enter the store ID assigned to your Sedifex workspace.',
      )
    }
    const trimmed = candidate.trim()
    if (!trimmed) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Enter the store ID assigned to your Sedifex workspace.',
      )
    }
    requestedStoreId = trimmed
  }

  if (!emailFromToken) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'A verified email is required to resolve store access for this account.',
    )
  }

  let sheetRow: Awaited<ReturnType<typeof fetchClientRowByEmail>>
  try {
    sheetRow = await fetchClientRowByEmail(getDefaultSpreadsheetId(), emailFromToken)
  } catch (error) {
    functions.logger.error('[resolveStoreAccess] Failed to query Google Sheets', error)
    throw new functions.https.HttpsError('internal', 'Unable to verify workspace access at this time.')
  }

  if (!sheetRow) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'We could not find a workspace assignment for this account. Reach out to your Sedifex administrator.',
    )
  }

  const record = sheetRow.record
  const now = admin.firestore.Timestamp.now()

  const memberRef = rosterDb.collection('teamMembers').doc(uid)
  const memberSnap = await memberRef.get()
  const existingMember = memberSnap.data() ?? {}

  const existingStoreId =
    typeof existingMember.storeId === 'string' && existingMember.storeId.trim() !== ''
      ? (existingMember.storeId as string).trim()
      : null

  const sheetStoreIdValue = getValueFromRecord(record, [
    'store_id',
    'storeid',
    'store_identifier',
    'store',
  ])
  const normalizedSheetStoreId =
    typeof sheetStoreIdValue === 'string' ? sheetStoreIdValue.trim() : ''

  const missingStoreIdMessage =
    'We could not confirm the store ID assigned to your Sedifex workspace. Reach out to your Sedifex administrator.'

  if (requestedStoreId !== null) {
    if (!normalizedSheetStoreId) {
      throw new functions.https.HttpsError('failed-precondition', missingStoreIdMessage)
    }
    if (requestedStoreId !== normalizedSheetStoreId) {
      throw new functions.https.HttpsError(
        'permission-denied',
        `Your account is assigned to store ${normalizedSheetStoreId}. Enter the correct store ID to continue.`,
      )
    }
  }

  const storeIdCandidate = normalizedSheetStoreId || existingStoreId || null

  if (!storeIdCandidate) {
    throw new functions.https.HttpsError('failed-precondition', missingStoreIdMessage)
  }

  const storeId = storeIdCandidate

  const resolvedRoleCandidate = getValueFromRecord(record, ['role', 'member_role', 'store_role', 'workspace_role'])
  let resolvedRole = 'staff'
  if (resolvedRoleCandidate) {
    const normalizedRole = resolvedRoleCandidate.toLowerCase()
    if (VALID_ROLES.has(normalizedRole)) {
      resolvedRole = normalizedRole
    } else if (normalizedRole.includes('owner')) {
      resolvedRole = 'owner'
    }
  } else if (typeof existingMember.role === 'string' && VALID_ROLES.has(existingMember.role)) {
    resolvedRole = existingMember.role
  }

  const memberEmail =
    getEmailFromRecord(record, ['member_email', 'email', 'primary_email', 'user_email']) ?? emailFromToken
  const memberPhone =
    getValueFromRecord(record, ['member_phone', 'phone', 'contact_phone', 'store_contact_phone']) ??
    (typeof existingMember.phone === 'string' ? existingMember.phone : null)
  const firstSignupEmail =
    getEmailFromRecord(record, ['first_signup_email', 'signup_email']) ??
    (typeof existingMember.firstSignupEmail === 'string'
      ? existingMember.firstSignupEmail
      : emailFromToken)
  const memberName =
    getValueFromRecord(record, ['member_name', 'contact_name', 'staff_name', 'name']) ??
    (typeof existingMember.name === 'string' ? existingMember.name : null)
  const invitedBy =
    getValueFromRecord(record, ['invited_by', 'inviter_uid', 'invitedby']) ??
    (typeof existingMember.invitedBy === 'string' ? existingMember.invitedBy : null)

  const memberCreatedAt =
    memberSnap.exists && existingMember.createdAt instanceof admin.firestore.Timestamp
      ? (existingMember.createdAt as admin.firestore.Timestamp)
      : now

  const memberData: admin.firestore.DocumentData = {
    uid,
    storeId,
    role: resolvedRole,
    email: memberEmail,
    updatedAt: now,
    createdAt: memberCreatedAt,
  }
  if (memberPhone) memberData.phone = memberPhone
  if (memberName) memberData.name = memberName
  if (firstSignupEmail) memberData.firstSignupEmail = firstSignupEmail
  if (invitedBy) memberData.invitedBy = invitedBy

  await memberRef.set(memberData, { merge: true })

  const storeRef = defaultDb.collection('stores').doc(storeId)
  const storeSnap = await storeRef.get()
  const existingStore = storeSnap.data() ?? {}
  const storeCreatedAt =
    storeSnap.exists && existingStore.createdAt instanceof admin.firestore.Timestamp
      ? (existingStore.createdAt as admin.firestore.Timestamp)
      : now

  const storeName =
    getValueFromRecord(record, ['store_name', 'workspace_name', 'store']) ??
    (typeof existingStore.name === 'string' ? existingStore.name : null)
  const storeDisplayName =
    getValueFromRecord(record, ['store_display_name', 'display_name']) ??
    (typeof existingStore.displayName === 'string' ? existingStore.displayName : null)
  const storeEmail =
    getEmailFromRecord(record, ['store_email', 'contact_email', 'store_contact_email']) ??
    (typeof existingStore.email === 'string' ? existingStore.email : null)
  const storePhone =
    getValueFromRecord(record, ['store_phone', 'contact_phone', 'store_contact_phone']) ??
    (typeof existingStore.phone === 'string' ? existingStore.phone : null)
  const storeTimezone =
    getValueFromRecord(record, ['store_timezone', 'timezone']) ??
    (typeof existingStore.timezone === 'string' ? existingStore.timezone : null)
  const storeCurrency =
    getValueFromRecord(record, ['store_currency', 'currency']) ??
    (typeof existingStore.currency === 'string' ? existingStore.currency : null)
  const storeStatus =
    getValueFromRecord(record, ['store_status', 'status']) ??
    (typeof existingStore.status === 'string' ? existingStore.status : null)
  const contractStart =
    getTimestampFromRecord(record, [
      'contractStart',
      'contract_start',
      'contract_start_date',
      'contract_start_at',
      'start_date',
    ]) ??
    (existingStore.contractStart instanceof admin.firestore.Timestamp
      ? existingStore.contractStart
      : null)
  const contractEnd =
    getTimestampFromRecord(record, [
      'contractEnd',
      'contract_end',
      'contract_end_date',
      'contract_end_at',
      'end_date',
    ]) ??
    (existingStore.contractEnd instanceof admin.firestore.Timestamp
      ? existingStore.contractEnd
      : null)
  const paymentStatus =
    getValueFromRecord(record, ['paymentStatus', 'payment_status', 'contract_payment_status']) ??
    (typeof existingStore.paymentStatus === 'string' ? existingStore.paymentStatus : null)
  const amountPaid =
    getNumberFromRecord(record, ['amountPaid', 'amount_paid', 'payment_amount', 'contract_amount_paid']) ??
    (typeof existingStore.amountPaid === 'number' && Number.isFinite(existingStore.amountPaid)
      ? (existingStore.amountPaid as number)
      : null)
  const company =
    getValueFromRecord(record, ['company', 'company_name', 'business_name']) ??
    (typeof existingStore.company === 'string' ? existingStore.company : null)

  if (isInactiveContractStatus(storeStatus)) {
    throw new functions.https.HttpsError('permission-denied', INACTIVE_WORKSPACE_MESSAGE)
  }
  const storeAddressLine1 =
    getValueFromRecord(record, ['store_address_line1', 'address_line1', 'address_1']) ??
    (typeof existingStore.addressLine1 === 'string' ? existingStore.addressLine1 : null)
  const storeAddressLine2 =
    getValueFromRecord(record, ['store_address_line2', 'address_line2', 'address_2']) ??
    (typeof existingStore.addressLine2 === 'string' ? existingStore.addressLine2 : null)
  const storeCity =
    getValueFromRecord(record, ['store_city', 'city']) ??
    (typeof existingStore.city === 'string' ? existingStore.city : null)
  const storeRegion =
    getValueFromRecord(record, ['store_region', 'region', 'state', 'province']) ??
    (typeof existingStore.region === 'string' ? existingStore.region : null)
  const storePostalCode =
    getValueFromRecord(record, ['store_postal_code', 'postal_code', 'zip']) ??
    (typeof existingStore.postalCode === 'string' ? existingStore.postalCode : null)
  const storeCountry =
    getValueFromRecord(record, ['store_country', 'country']) ??
    (typeof existingStore.country === 'string' ? existingStore.country : null)

  const storeData: admin.firestore.DocumentData = {
    storeId,
    updatedAt: now,
    createdAt: storeCreatedAt,
  }
  if (storeName) storeData.name = storeName
  if (storeDisplayName) storeData.displayName = storeDisplayName
  if (storeEmail) storeData.email = storeEmail
  if (storePhone) storeData.phone = storePhone
  if (storeTimezone) storeData.timezone = storeTimezone
  if (storeCurrency) storeData.currency = storeCurrency
  if (storeStatus) storeData.status = storeStatus
  if (storeAddressLine1) storeData.addressLine1 = storeAddressLine1
  if (storeAddressLine2) storeData.addressLine2 = storeAddressLine2
  if (storeCity) storeData.city = storeCity
  if (storeRegion) storeData.region = storeRegion
  if (storePostalCode) storeData.postalCode = storePostalCode
  if (storeCountry) storeData.country = storeCountry
  if (contractStart) storeData.contractStart = contractStart
  if (contractEnd) storeData.contractEnd = contractEnd
  if (paymentStatus) storeData.paymentStatus = paymentStatus
  if (amountPaid !== null) storeData.amountPaid = amountPaid
  if (company) storeData.company = company

  await storeRef.set(storeData, { merge: true })

  const productSeeds = mapProductSeeds(record, storeId)
  const customerSeeds = mapCustomerSeeds(record, storeId)

  const productResults = await Promise.all(
    productSeeds.map(async seed => {
      const ref = defaultDb.collection('products').doc(seed.id)
      const snapshot = await ref.get()
      const existingProduct = snapshot.data() ?? {}
      const productCreatedAt =
        snapshot.exists && existingProduct.createdAt instanceof admin.firestore.Timestamp
          ? (existingProduct.createdAt as admin.firestore.Timestamp)
          : now
      const productData: admin.firestore.DocumentData = {
        ...seed.data,
        createdAt: productCreatedAt,
        updatedAt: now,
      }
      await ref.set(productData, { merge: true })
      return { id: ref.id, data: productData }
    }),
  )

  const customerResults = await Promise.all(
    customerSeeds.map(async seed => {
      const ref = defaultDb.collection('customers').doc(seed.id)
      const snapshot = await ref.get()
      const existingCustomer = snapshot.data() ?? {}
      const customerCreatedAt =
        snapshot.exists && existingCustomer.createdAt instanceof admin.firestore.Timestamp
          ? (existingCustomer.createdAt as admin.firestore.Timestamp)
          : now
      const customerData: admin.firestore.DocumentData = {
        ...seed.data,
        createdAt: customerCreatedAt,
        updatedAt: now,
      }
      await ref.set(customerData, { merge: true })
      return { id: ref.id, data: customerData }
    }),
  )

  const claims = await updateUserClaims(uid, resolvedRole)

  return {
    ok: true,
    storeId,
    role: resolvedRole,
    claims,
    spreadsheetId: sheetRow.spreadsheetId,
    teamMember: { id: memberRef.id, data: serializeFirestoreData(memberData) },
    store: { id: storeRef.id, data: serializeFirestoreData(storeData) },
    products: productResults.map(item => ({ id: item.id, data: serializeFirestoreData(item.data) })),
    customers: customerResults.map(item => ({ id: item.id, data: serializeFirestoreData(item.data) })),
  }
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

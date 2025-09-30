import * as functions from 'firebase-functions'
import { applyRoleClaims } from './customClaims'
import { admin, defaultDb, rosterDb } from './firestore'
import { deriveStoreIdFromContext, withCallableErrorLogging } from './telemetry'
import { FIREBASE_CALLABLES } from '../../shared/firebaseCallables'

const db = defaultDb

type ContactPayload = {
  phone?: unknown
  phoneCountryCode?: unknown
  phoneLocalNumber?: unknown
  firstSignupEmail?: unknown
}

type BackfillPayload = {
  contact?: ContactPayload
}

function normalizeContact(contact: ContactPayload | undefined) {
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

export const backfillMyStore = functions.https.onCall(
  withCallableErrorLogging(
    FIREBASE_CALLABLES.BACKFILL_MY_STORE,
    async (data, context) => {
      if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')

      const uid = context.auth.uid
      const token = context.auth.token as Record<string, unknown>
      const email = typeof token.email === 'string' ? (token.email as string) : null
      const phone = typeof token.phone_number === 'string' ? (token.phone_number as string) : null

      const payload = (data ?? {}) as BackfillPayload
      const contact = normalizeContact(payload.contact)
      const resolvedPhone = contact.hasPhone ? contact.phone ?? null : phone ?? null
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
      const claims = await applyRoleClaims({ uid, role: 'owner', storeId })

      return { ok: true, claims, storeId }
    },
    {
      resolveStoreId: async (_data, context) => {
        const uid = context.auth?.uid
        if (uid) {
          try {
            const memberSnap = await rosterDb.collection('teamMembers').doc(uid).get()
            const existingStoreId = memberSnap?.data()?.storeId
            if (typeof existingStoreId === 'string') {
              const trimmed = existingStoreId.trim()
              if (trimmed) {
                return trimmed
              }
            }
          } catch (error) {
            functions.logger.warn('[backfillMyStore] Failed to resolve storeId for telemetry', {
              error,
            })
          }
        }

        const fromContext = deriveStoreIdFromContext(context)
        if (fromContext) return fromContext
        return uid ?? null
      },
    },
  ),
)

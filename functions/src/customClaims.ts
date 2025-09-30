import { admin, defaultDb, rosterDb } from './firestore'

export type RoleClaimPayload = {
  uid: string
  role: string
  storeId: string
}

function normalizeCompany(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function resolveCompanyName(uid: string, storeId: string): Promise<string | null> {
  try {
    const memberSnap = await rosterDb.collection('teamMembers').doc(uid).get()
    const storeSnap = storeId ? await defaultDb.collection('stores').doc(storeId).get() : null

    const memberCompany = normalizeCompany(memberSnap?.data()?.company)
    const storeCompany = normalizeCompany(storeSnap?.data()?.company)
    return storeCompany ?? memberCompany ?? null
  } catch (error) {
    console.warn('[customClaims] Failed to resolve company name for claims', { uid, storeId, error })
    return null
  }
}

export async function applyRoleClaims({ uid, role, storeId }: RoleClaimPayload) {
  const userRecord = await admin
    .auth()
    .getUser(uid)
    .catch(() => null)
  const existingClaims = (userRecord?.customClaims ?? {}) as Record<string, unknown>
  const nextClaims: Record<string, unknown> = { ...existingClaims }

  nextClaims.role = role
  nextClaims.activeStoreId = storeId

  const companyName = await resolveCompanyName(uid, storeId)
  if (companyName) {
    nextClaims.company = companyName
  } else {
    delete nextClaims.company
  }

  delete nextClaims.stores
  delete nextClaims.storeId
  delete nextClaims.roleByStore

  await admin.auth().setCustomUserClaims(uid, nextClaims)
  return nextClaims
}

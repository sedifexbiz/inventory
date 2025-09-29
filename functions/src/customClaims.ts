import { admin } from './firestore'

export type RoleClaimPayload = {
  uid: string
  role: string
  storeId: string
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

  delete nextClaims.stores
  delete nextClaims.storeId
  delete nextClaims.roleByStore

  await admin.auth().setCustomUserClaims(uid, nextClaims)
  return nextClaims
}

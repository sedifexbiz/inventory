// web/src/controllers/storeController.ts
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { FIREBASE_CALLABLES } from '@shared/firebaseCallables'

type ManageStaffAccountPayload = {
  storeId: string
  email: string
  role: string
  password?: string
}

type ManageStaffAccountResult = {
  ok: boolean
  storeId: string
  role: string
  email: string
  uid: string
  created: boolean
}

type UpdateStoreProfilePayload = {
  storeId: string
  name: string
  timezone: string
  currency: string
}

type UpdateStoreProfileResult = {
  ok: boolean
  storeId: string
}

type RevokeStaffAccessPayload = {
  storeId: string
  uid: string
}

type RevokeStaffAccessResult = {
  ok: boolean
  storeId: string
  uid: string
}

export async function manageStaffAccount(payload: ManageStaffAccountPayload) {
  const callable = httpsCallable<ManageStaffAccountPayload, ManageStaffAccountResult>(
    functions,
    FIREBASE_CALLABLES.MANAGE_STAFF_ACCOUNT,
  )
  const response = await callable(payload)
  return response.data
}

export async function updateStoreProfile(payload: UpdateStoreProfilePayload) {
  const callable = httpsCallable<UpdateStoreProfilePayload, UpdateStoreProfileResult>(
    functions,
    FIREBASE_CALLABLES.UPDATE_STORE_PROFILE,
  )
  const response = await callable(payload)
  return response.data
}

export async function revokeStaffAccess(payload: RevokeStaffAccessPayload) {
  const callable = httpsCallable<RevokeStaffAccessPayload, RevokeStaffAccessResult>(
    functions,
    FIREBASE_CALLABLES.REVOKE_STAFF_ACCESS,
  )
  const response = await callable(payload)
  return response.data
}

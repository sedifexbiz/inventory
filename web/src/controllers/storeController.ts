// web/src/controllers/storeController.ts
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

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

export async function manageStaffAccount(payload: ManageStaffAccountPayload) {
  const callable = httpsCallable<ManageStaffAccountPayload, ManageStaffAccountResult>(
    functions,
    'manageStaffAccount',
  )
  const response = await callable(payload)
  return response.data
}

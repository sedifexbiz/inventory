import * as admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

if (!admin.apps.length) {
  admin.initializeApp()
}

export const defaultDb = getFirestore()
export const rosterDb = getFirestore(admin.app(), 'roster')

export { admin }

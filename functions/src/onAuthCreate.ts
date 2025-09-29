import * as functions from 'firebase-functions'
import { admin, rosterDb } from './firestore'

export const onAuthCreate = functions.auth.user().onCreate(async user => {
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

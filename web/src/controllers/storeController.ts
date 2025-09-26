// web/src/controllers/storeController.ts
import { getAuth } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export async function createMyFirstStore() {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');

  const storeId = user.uid;

  // 1) Create the store (id == uid)
  await setDoc(doc(db, 'stores', storeId), {
    storeId,
    ownerId: user.uid,
    ownerEmail: user.email ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  // 2) Create the owner membership (members/{uid})
  await setDoc(doc(db, 'stores', storeId, 'members', user.uid), {
    storeId,
    uid: user.uid,
    role: 'owner',
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    photoURL: user.photoURL ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  // Optional: if any legacy code still checks custom claims, refresh token
  await user.getIdToken(true);
}

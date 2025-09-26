// web/src/DebugButtons.tsx
import * as React from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

export default function DebugButtons() {
  const readTest = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return console.error('Not signed in');
    const snap = await getDoc(doc(db, `stores/${uid}/members/${uid}`));
    console.log('exists?', snap.exists(), snap.data());
  };

  const writeTest = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return console.error('Not signed in');
    await setDoc(doc(db, 'products', crypto.randomUUID()), {
      name: 'Test Product',
      price: 10,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      storeId: uid,
    });
    console.log('Write OK');
  };

  return (
    <div style={{ padding: 24 }}>
      <button onClick={readTest}>Read Test</button>
      <button onClick={writeTest} style={{ marginLeft: 12 }}>Write Test</button>
    </div>
  );
}

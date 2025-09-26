// web/src/hooks/useMemberships.ts
import { useEffect, useState } from 'react';
import { collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';           // your initialized Firestore
import { useAuthUser } from './useAuthUser';

export type Membership = {
  storeId: string;
  uid: string;
  role: 'owner'|'manager'|'cashier';
  displayName?: string | null;
  photoURL?: string | null;
};

export function useMemberships() {
  const user = useAuthUser();
  const [loading, setLoading] = useState(true);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!cancelled) setError(null);
        if (!user) {
          if (!cancelled) {
            setMemberships([]);
            setError(null);
            setLoading(false);
          }
          return;
        }
        // members docs should include 'uid' and 'storeId' fields (write them when creating)
        const cg = collectionGroup(db, 'members');
        const q = query(cg, where('uid', '==', user.uid));
        const snap = await getDocs(q);

        if (cancelled) return;
        const rows: Membership[] = snap.docs.map(d => {
          const data = d.data() as any;
          return {
            storeId: data.storeId,
            uid: data.uid,
            role: data.role,
            displayName: data.displayName ?? null,
            photoURL: data.photoURL ?? null,
          };
        });
        setMemberships(rows);
        setError(null);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  return { loading, memberships, error };
}

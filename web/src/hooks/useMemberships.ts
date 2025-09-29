// web/src/hooks/useMemberships.ts
import { useEffect, useState } from 'react'
import {
  Timestamp,
  collection,
  getDocs,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '../firebase'
import { useAuthUser } from './useAuthUser'

export type Membership = {
  id: string
  uid: string
  role: 'owner' | 'staff'
  storeId: string | null
  email: string | null
  phone: string | null
  invitedBy: string | null
  firstSignupEmail: string | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
}

function normalizeRole(role: unknown): Membership['role'] {
  if (role === 'owner') return 'owner'
  return 'staff'
}

function mapMembershipSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Membership {
  const data = snapshot.data()

  const createdAt = data.createdAt instanceof Timestamp ? data.createdAt : null
  const updatedAt = data.updatedAt instanceof Timestamp ? data.updatedAt : null
  const storeId = typeof data.storeId === 'string' && data.storeId.trim() !== '' ? data.storeId : null

  return {
    id: snapshot.id,
    uid: typeof data.uid === 'string' && data.uid.trim() ? data.uid : snapshot.id,
    role: normalizeRole(data.role),
    storeId,
    email: typeof data.email === 'string' ? data.email : null,
    phone: typeof data.phone === 'string' ? data.phone : null,
    invitedBy: typeof data.invitedBy === 'string' ? data.invitedBy : null,
    firstSignupEmail: typeof data.firstSignupEmail === 'string' ? data.firstSignupEmail : null,
    createdAt,
    updatedAt,
  }
}

export function useMemberships(activeStoreId?: string | null) {
  const user = useAuthUser()
  const [loading, setLoading] = useState(true)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false

    async function loadMemberships() {
      if (!user) {
        if (!cancelled) {
          setMemberships([])
          setError(null)
          setLoading(false)
        }
        return
      }

      if (activeStoreId === undefined) {
        if (!cancelled) {
          setLoading(true)
          setError(null)
          setMemberships([])
        }
        return
      }

      if (!cancelled) {
        setLoading(true)
        setError(null)
      }

      try {
        const membersRef = collection(db, 'teamMembers')
        const constraints = [where('uid', '==', user.uid)]
        const normalizedStoreId =
          typeof activeStoreId === 'string' && activeStoreId.trim() !== ''
            ? activeStoreId
            : null

        if (normalizedStoreId) {
          constraints.push(where('storeId', '==', normalizedStoreId))
        }

        const membershipsQuery = query(membersRef, ...constraints)
        const snapshot = await getDocs(membershipsQuery)

        if (cancelled) return

        const rows = snapshot.docs.map(mapMembershipSnapshot)
        setMemberships(rows)
        setError(null)
      } catch (e) {
        if (!cancelled) {
          setError(e)
          setMemberships([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadMemberships()

    return () => {
      cancelled = true
    }
  }, [activeStoreId, user?.uid])

  return { loading, memberships, error }
}

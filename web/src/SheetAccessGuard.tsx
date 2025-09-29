import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { auth, db } from './firebase'

type TeamMemberSnapshot = {
  storeId: string | null
  status: string | null
  contractStatus: string | null
}

const BLOCKED_STATUSES = new Set([
  'inactive',
  'disabled',
  'suspended',
  'terminated',
  'cancelled',
  'canceled',
  'expired',
])

function normalizeString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  return null
}

function snapshotFromData(data: Record<string, unknown> | undefined): TeamMemberSnapshot {
  if (!data) {
    return { storeId: null, status: null, contractStatus: null }
  }

  const storeId = normalizeString(data['storeId'])
  const status = normalizeString(data['status'])
  const contractStatus = normalizeString(data['contractStatus'])

  return { storeId, status, contractStatus }
}

async function loadTeamMember(user: User): Promise<TeamMemberSnapshot> {
  const uidRef = doc(db, 'teamMembers', user.uid)
  const uidSnapshot = await getDoc(uidRef)

  if (uidSnapshot.exists()) {
    return snapshotFromData(uidSnapshot.data())
  }

  const email = normalizeString(user.email)
  if (!email) {
    return { storeId: null, status: null, contractStatus: null }
  }

  const membersRef = collection(db, 'teamMembers')
  const candidates = await getDocs(query(membersRef, where('email', '==', email)))
  const match = candidates.docs[0]
  if (!match) {
    return { storeId: null, status: null, contractStatus: null }
  }

  return snapshotFromData(match.data())
}

function isWorkspaceActive({ status, contractStatus }: TeamMemberSnapshot): boolean {
  const candidates = [status, contractStatus]
    .map(value => normalizeString(value ?? undefined))
    .filter((value): value is string => Boolean(value))

  if (candidates.length === 0) {
    return true
  }

  return candidates.every(value => !BLOCKED_STATUSES.has(value.toLowerCase()))
}

export default function SheetAccessGuard({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
      if (!user) {
        setError(null)
        setReady(true)
        return
      }

      try {
        setError(null)
        const member = await loadTeamMember(user)
        if (!member.storeId) {
          throw new Error('We could not find a workspace assignment for this account.')
        }

        if (!isWorkspaceActive(member)) {
          throw new Error('Your Sedifex workspace contract is not active.')
        }

        if (typeof window !== 'undefined') {
          window.localStorage.setItem('activeStoreId', member.storeId)
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Access denied.'
        setError(message)
        await signOut(auth)
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem('activeStoreId')
        }
      } finally {
        setReady(true)
      }
    })

    return () => unsubscribe()
  }, [])

  if (!ready) return <p>Checking workspace access…</p>
  return (
    <>
      {error ? <div role="alert">{error}</div> : null}
      {children}
    </>
  )
}

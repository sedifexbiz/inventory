import { describe, expect, test } from 'vitest'

type Role = 'owner' | 'staff' | undefined

type AuthContext = {
  uid: string
  token: {
    role?: Role
  }
} | null

function isAuthed(auth: AuthContext): auth is { uid: string; token: { role?: Role } } {
  return auth !== null
}

function hasAnyRole(roles: readonly Role[], auth: AuthContext) {
  return isAuthed(auth) && roles.includes((auth.token.role ?? undefined) as Role)
}

function ownerOrSelf(uid: string, auth: AuthContext) {
  return hasAnyRole(['owner'], auth) || (isAuthed(auth) && auth.uid === uid)
}

function staffAccess(auth: AuthContext) {
  return hasAnyRole(['owner', 'staff'], auth)
}

describe('Firestore security rules helpers (single tenant)', () => {
  const ownerAuth: AuthContext = { uid: 'owner-1', token: { role: 'owner' } }
  const staffAuth: AuthContext = { uid: 'staff-1', token: { role: 'staff' } }
  const outsiderAuth: AuthContext = { uid: 'outsider-1', token: {} }

  test('owner can manage team members', () => {
    expect(ownerOrSelf('team-1', ownerAuth)).toBe(true)
    expect(hasAnyRole(['owner'], ownerAuth)).toBe(true)
  })

  test('staff cannot write team member documents', () => {
    expect(hasAnyRole(['owner'], staffAuth)).toBe(false)
  })

  test('users can read their own team member document', () => {
    expect(ownerOrSelf('staff-1', staffAuth)).toBe(true)
    expect(ownerOrSelf('staff-1', outsiderAuth)).toBe(false)
  })

  test('owner and staff can access business resources', () => {
    expect(staffAccess(ownerAuth)).toBe(true)
    expect(staffAccess(staffAuth)).toBe(true)
  })

  test('users without a role cannot access business resources', () => {
    expect(staffAccess(outsiderAuth)).toBe(false)
  })
})

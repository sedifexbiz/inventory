import { describe, expect, test } from 'vitest'

type MemberDoc = {
  storeId?: string | null
  role?: string | null
} | null

function memberStoreId(member: MemberDoc): string | null {
  const store = member?.storeId
  return typeof store === 'string' && store.trim() ? store : null
}

function memberRole(member: MemberDoc): 'owner' | 'staff' | null {
  const role = member?.role
  if (typeof role !== 'string') return null
  const normalized = role.trim().toLowerCase()
  return normalized === 'owner' || normalized === 'staff' ? normalized : null
}

function hasStaffAccess(member: MemberDoc): boolean {
  const role = memberRole(member)
  return role === 'owner' || role === 'staff'
}

function hasOwnerAccess(member: MemberDoc): boolean {
  return memberRole(member) === 'owner'
}

function matchesStore(member: MemberDoc, storeId: string): boolean {
  const store = memberStoreId(member)
  return store !== null && store === storeId
}

describe('Firestore rules helpers - membership derived access', () => {
  const owner: MemberDoc = { storeId: 'store-1', role: 'owner' }
  const staff: MemberDoc = { storeId: 'store-1', role: 'staff' }
  const outsider: MemberDoc = { storeId: 'store-2', role: 'staff' }
  const unknown: MemberDoc = null

  test('owner has owner and staff access for their store', () => {
    expect(memberStoreId(owner)).toBe('store-1')
    expect(memberRole(owner)).toBe('owner')
    expect(hasOwnerAccess(owner)).toBe(true)
    expect(hasStaffAccess(owner)).toBe(true)
    expect(matchesStore(owner, 'store-1')).toBe(true)
  })

  test('staff has staff access but not owner privileges', () => {
    expect(memberStoreId(staff)).toBe('store-1')
    expect(memberRole(staff)).toBe('staff')
    expect(hasStaffAccess(staff)).toBe(true)
    expect(hasOwnerAccess(staff)).toBe(false)
    expect(matchesStore(staff, 'store-1')).toBe(true)
  })

  test('members cannot access other stores', () => {
    expect(matchesStore(owner, 'store-2')).toBe(false)
    expect(matchesStore(staff, 'store-2')).toBe(false)
    expect(hasStaffAccess(outsider)).toBe(true)
    expect(matchesStore(outsider, 'store-1')).toBe(false)
  })

  test('missing membership data denies access', () => {
    expect(memberStoreId(unknown)).toBeNull()
    expect(memberRole(unknown)).toBeNull()
    expect(hasStaffAccess(unknown)).toBe(false)
    expect(hasOwnerAccess(unknown)).toBe(false)
    expect(matchesStore(unknown, 'store-1')).toBe(false)
  })
})

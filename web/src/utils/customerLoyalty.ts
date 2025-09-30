import type { Timestamp } from 'firebase/firestore'

export type CustomerLoyalty = {
  points: number
  lastVisitAt: Timestamp | null
}

export function createCustomerLoyalty(): CustomerLoyalty {
  return { points: 0, lastVisitAt: null }
}

function isTimestamp(value: unknown): value is Timestamp {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Timestamp).toDate === 'function' &&
    typeof (value as Timestamp).toMillis === 'function'
  )
}

export function normalizeCustomerLoyalty(value: unknown): CustomerLoyalty {
  if (!value || typeof value !== 'object') {
    return createCustomerLoyalty()
  }

  const source = value as { points?: unknown; lastVisitAt?: unknown }
  const points =
    typeof source.points === 'number' && Number.isFinite(source.points) ? source.points : 0
  const lastVisitAt = isTimestamp(source.lastVisitAt) ? source.lastVisitAt : null

  return { points, lastVisitAt }
}

export function ensureCustomerLoyalty<T extends { loyalty?: unknown }>(
  customer: T,
): Omit<T, 'loyalty'> & { loyalty: CustomerLoyalty } {
  return {
    ...(customer as Omit<T, 'loyalty'>),
    loyalty: normalizeCustomerLoyalty(customer.loyalty),
  }
}

export function loyaltyTimestampToDate(timestamp: Timestamp | null): Date | null {
  if (!timestamp) return null
  try {
    return timestamp.toDate()
  } catch (error) {
    console.warn('[loyalty] Failed to convert loyalty timestamp', error)
    return null
  }
}

import type { StoreRole } from '../hooks/useActiveStore'

export type AppFeature =
  | 'dashboard'
  | 'products'
  | 'sell'
  | 'receive'
  | 'customers'
  | 'close-day'
  | 'settings'
  | 'onboarding'

const FEATURE_LABELS: Record<AppFeature, string> = {
  'dashboard': 'Dashboard',
  'products': 'Products',
  'sell': 'Sell',
  'receive': 'Receive',
  'customers': 'Customers',
  'close-day': 'Close Day',
  'settings': 'Settings',
  'onboarding': 'Owner onboarding',
}

const FEATURE_PERMISSIONS: Record<AppFeature, ReadonlyArray<StoreRole>> = {
  'dashboard': ['owner', 'manager', 'cashier'],
  'products': ['owner', 'manager'],
  'sell': ['owner', 'manager', 'cashier'],
  'receive': ['owner', 'manager', 'cashier'],
  'customers': ['owner', 'manager'],
  'close-day': ['owner', 'manager'],
  'settings': ['owner'],
  'onboarding': ['owner'],
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
}

function normalizeRole(role: StoreRole | null): string | null {
  if (typeof role !== 'string') {
    return null
  }

  const normalized = role.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

export function canAccessFeature(role: StoreRole | null, feature: AppFeature): boolean {
  const normalizedRole = normalizeRole(role)
  if (!normalizedRole) {
    return false
  }

  const allowedRoles = FEATURE_PERMISSIONS[feature]
  if (!allowedRoles) {
    return false
  }

  return allowedRoles.some(allowedRole => normalizeRole(allowedRole) === normalizedRole)
}

export function getFeatureLabel(feature: AppFeature): string {
  return FEATURE_LABELS[feature] ?? feature
}

export function formatRoleLabel(role: StoreRole | null): string {
  const normalizedRole = normalizeRole(role)
  if (!normalizedRole) {
    return 'your assigned role'
  }

  return ROLE_LABELS[normalizedRole] ?? role ?? 'your assigned role'
}

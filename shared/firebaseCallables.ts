export const FIREBASE_CALLABLES = {
  BACKFILL_MY_STORE: 'backfillMyStore',
  INITIALIZE_STORE: 'initializeStore',
  AFTER_SIGNUP_BOOTSTRAP: 'afterSignupBootstrap',
  RESOLVE_STORE_ACCESS: 'resolveStoreAccess',
  MANAGE_STAFF_ACCOUNT: 'manageStaffAccount',
  REVOKE_STAFF_ACCESS: 'revokeStaffAccess',
  UPDATE_STORE_PROFILE: 'updateStoreProfile',
  RECEIVE_STOCK: 'receiveStock',
} as const

export type FirebaseCallableName = (typeof FIREBASE_CALLABLES)[keyof typeof FIREBASE_CALLABLES]

export type FirebaseCallableKey = keyof typeof FIREBASE_CALLABLES

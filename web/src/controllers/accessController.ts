// web/src/controllers/accessController.ts
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { FIREBASE_CALLABLES } from '@shared/firebaseCallables'

type RawSeededDocument = {
  id?: unknown
  data?: unknown
}

type RawResolveStoreAccessResponse = {
  ok?: unknown
  storeId?: unknown
  role?: unknown
  teamMember?: RawSeededDocument
  store?: RawSeededDocument
  products?: RawSeededDocument[] | unknown
  customers?: RawSeededDocument[] | unknown
}

export type SeededDocument = {
  id: string
  data: Record<string, unknown>
}

export type ResolveStoreAccessResult = {
  ok: boolean
  storeId: string
  role: 'owner' | 'staff'
  teamMember: SeededDocument | null
  store: SeededDocument | null
  products: SeededDocument[]
  customers: SeededDocument[]
}

function normalizeRole(value: unknown): 'owner' | 'staff' {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'owner') return 'owner'
  }
  return 'staff'
}

function normalizeSeededDocument(input: RawSeededDocument | unknown): SeededDocument | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const candidate = input as RawSeededDocument
  const rawId = candidate.id
  if (typeof rawId !== 'string') {
    return null
  }

  const id = rawId.trim()
  if (!id) {
    return null
  }

  const rawData = candidate.data
  if (!rawData || typeof rawData !== 'object') {
    return { id, data: {} }
  }

  return { id, data: { ...(rawData as Record<string, unknown>) } }
}

function normalizeSeededCollection(value: RawSeededDocument[] | unknown): SeededDocument[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(item => normalizeSeededDocument(item))
    .filter((item): item is SeededDocument => item !== null)
}

type ResolveStoreAccessPayload = {
  storeId?: string
}

type ContactPayload = {
  phone?: string | null
  phoneCountryCode?: string | null
  phoneLocalNumber?: string | null
  firstSignupEmail?: string | null
  company?: string | null
  ownerName?: string | null
}

type AfterSignupBootstrapPayload = {
  storeId?: string
  contact?: ContactPayload
}

const resolveStoreAccessCallable = httpsCallable<
  ResolveStoreAccessPayload,
  RawResolveStoreAccessResponse
>(
  functions,
  FIREBASE_CALLABLES.RESOLVE_STORE_ACCESS,
)

const afterSignupBootstrapCallable = httpsCallable<AfterSignupBootstrapPayload, void>(
  functions,
  FIREBASE_CALLABLES.AFTER_SIGNUP_BOOTSTRAP,
)

export const INACTIVE_WORKSPACE_MESSAGE =
  'Your Sedifex workspace contract is not active. Reach out to your Sedifex administrator to restore access.'

type FirebaseCallableError = FirebaseError & {
  customData?: {
    body?: {
      error?: { message?: unknown }
    }
  }
}

export function extractCallableErrorMessage(error: FirebaseError): string | null {
  const callableError = error as FirebaseCallableError
  const bodyMessage = callableError.customData?.body?.error?.message
  if (typeof bodyMessage === 'string') {
    const trimmed = bodyMessage.trim()
    if (trimmed) {
      return trimmed
    }
  }

  const raw = typeof error.message === 'string' ? error.message : ''
  const withoutFirebasePrefix = raw.replace(/^Firebase:\s*/i, '')
  const colonIndex = withoutFirebasePrefix.indexOf(':')
  const normalized =
    colonIndex >= 0
      ? withoutFirebasePrefix.slice(colonIndex + 1).trim()
      : withoutFirebasePrefix.trim()
  return normalized || null
}

export async function resolveStoreAccess(storeId?: string): Promise<ResolveStoreAccessResult> {
  let response
  try {
    const trimmedStoreId = typeof storeId === 'string' ? storeId.trim() : ''
    const payload = trimmedStoreId ? { storeId: trimmedStoreId } : undefined
    response = await resolveStoreAccessCallable(payload)
  } catch (error) {
    if (error instanceof FirebaseError && error.code === 'functions/permission-denied') {
      const message = extractCallableErrorMessage(error) ?? INACTIVE_WORKSPACE_MESSAGE
      throw new Error(message)
    }
    throw error
  }
  const payload = response.data ?? {}

  const ok = payload.ok === true
  const resolvedStoreId = typeof payload.storeId === 'string' ? payload.storeId.trim() : ''

  if (!ok || !resolvedStoreId) {
    throw new Error('Unable to resolve store access for this account.')
  }

  return {
    ok,
    storeId: resolvedStoreId,
    role: normalizeRole(payload.role),
    teamMember: normalizeSeededDocument(payload.teamMember ?? null),
    store: normalizeSeededDocument(payload.store ?? null),
    products: normalizeSeededCollection(payload.products),
    customers: normalizeSeededCollection(payload.customers),
  }
}

export async function afterSignupBootstrap(payload?: AfterSignupBootstrapPayload): Promise<void> {
  if (!payload) {
    await afterSignupBootstrapCallable(undefined)
    return
  }

  const normalized: AfterSignupBootstrapPayload = {}

  if (typeof payload.storeId === 'string') {
    const trimmed = payload.storeId.trim()
    if (trimmed) {
      normalized.storeId = trimmed
    }
  }

  if (payload.contact && typeof payload.contact === 'object') {
    const contact: NonNullable<AfterSignupBootstrapPayload['contact']> = {}

    if (payload.contact.phone !== undefined) {
      contact.phone = payload.contact.phone
    }

    if (payload.contact.phoneCountryCode !== undefined) {
      contact.phoneCountryCode = payload.contact.phoneCountryCode
    }

    if (payload.contact.phoneLocalNumber !== undefined) {
      contact.phoneLocalNumber = payload.contact.phoneLocalNumber
    }

    if (payload.contact.firstSignupEmail !== undefined) {
      contact.firstSignupEmail = payload.contact.firstSignupEmail
    }

    if (payload.contact.company !== undefined) {
      contact.company = payload.contact.company
    }

    if (payload.contact.ownerName !== undefined) {
      contact.ownerName = payload.contact.ownerName
    }

    if (Object.keys(contact).length > 0) {
      normalized.contact = contact
    }
  }

  const callablePayload = Object.keys(normalized).length > 0 ? normalized : undefined
  await afterSignupBootstrapCallable(callablePayload)
}

import * as functions from 'firebase-functions'
import { admin, defaultDb } from './firestore'
import { formatDailySummaryKey } from '../../shared/dateKeys'

type CallableContext = functions.https.CallableContext

const MAX_SANITIZE_DEPTH = 4
const MAX_ARRAY_SAMPLE = 5
const MAX_OBJECT_KEYS = 25

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SANITIZE_DEPTH) {
    return '[max-depth]'
  }

  if (value === null) return 'null'

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return valueType
  }

  if (valueType === 'bigint') return 'bigint'
  if (valueType === 'undefined') return 'undefined'
  if (valueType === 'symbol') return 'symbol'
  if (valueType === 'function') return 'function'

  if (Array.isArray(value)) {
    if (depth + 1 >= MAX_SANITIZE_DEPTH) {
      return { __type: 'array', length: value.length }
    }

    const samples = value.slice(0, MAX_ARRAY_SAMPLE).map(entry => sanitizePayload(entry, depth + 1))
    if (value.length > MAX_ARRAY_SAMPLE) {
      samples.push(`[+${value.length - MAX_ARRAY_SAMPLE} more]`)
    }
    return samples
  }

  if (value instanceof admin.firestore.Timestamp) {
    return 'timestamp'
  }

  if (value instanceof Date) {
    return 'date'
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)
    const result: Record<string, unknown> = {}
    for (const [key, entry] of entries) {
      result[key] = sanitizePayload(entry, depth + 1)
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      result.__truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS
    }
    return result
  }

  if (value && typeof value === 'object') {
    const constructorName = value.constructor?.name ?? 'object'
    return constructorName
  }

  return valueType
}

function sanitizeError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { message: typeof error === 'string' ? error : String(error) }
  }

  const result: Record<string, unknown> = {}
  const payload = error as Record<string, unknown>

  const message = payload.message
  if (typeof message === 'string' && message.trim()) {
    result.message = message
  }

  const code = payload.code
  if (typeof code === 'string' && code.trim()) {
    result.code = code
  }

  const status = payload.status
  if (typeof status === 'string' && status.trim()) {
    result.status = status
  }

  if ('details' in payload && payload.details !== undefined) {
    result.details = sanitizePayload(payload.details)
  }

  if (!('message' in result)) {
    result.message = String(error)
  }

  return result
}

export function deriveStoreIdFromContext(context: CallableContext): string | null {
  const token = (context.auth?.token ?? {}) as Record<string, unknown>
  const candidateKeys = ['activeStoreId', 'storeId', 'store_id', 'store', 'sid']
  for (const key of candidateKeys) {
    const raw = token?.[key]
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

type CallableErrorLogInput<T> = {
  route: string
  context: CallableContext
  data: T
  error: unknown
  storeId?: string | null
}

export async function logCallableError<T>({
  route,
  context,
  data,
  error,
  storeId,
}: CallableErrorLogInput<T>): Promise<void> {
  try {
    const timestamp = admin.firestore.Timestamp.now()
    const dateKey = formatDailySummaryKey(timestamp.toDate(), { timeZone: 'UTC' })
    const logDocRef = defaultDb.collection('logs').doc(dateKey)
    await logDocRef.set({ dateKey, createdAt: timestamp }, { merge: true })
    const eventsCollection = logDocRef.collection('events')
    const docRef = eventsCollection.doc()

    const payload = {
      route,
      storeId: (storeId ?? deriveStoreIdFromContext(context)) ?? null,
      authUid: context.auth?.uid ?? null,
      payloadShape: sanitizePayload(data),
      error: sanitizeError(error),
      createdAt: timestamp,
    }

    await docRef.set(payload, { merge: false })
  } catch (loggingError) {
    const loggingErrorMessage =
      loggingError instanceof Error ? loggingError.message : String(loggingError)
    functions.logger.error('[telemetry] Failed to record callable error', {
      route,
      loggingError: loggingErrorMessage,
    })
  }
}

type ResolveStoreIdFn<T> = (
  data: T,
  context: CallableContext,
  error: unknown,
) => string | null | Promise<string | null>

type CallableHandler<T, R> = (data: T, context: CallableContext) => R | Promise<R>

type WithLoggingOptions<T> = {
  resolveStoreId?: ResolveStoreIdFn<T>
}

async function safelyResolveStoreId<T>(
  resolver: ResolveStoreIdFn<T> | undefined,
  data: T,
  context: CallableContext,
  error: unknown,
): Promise<string | null | undefined> {
  if (!resolver) return undefined
  try {
    return await resolver(data, context, error)
  } catch (resolveError) {
    functions.logger.warn('[telemetry] Failed to resolve storeId for callable error', {
      resolveError,
    })
    return undefined
  }
}

export function withCallableErrorLogging<T, R>(
  route: string,
  handler: CallableHandler<T, R>,
  options: WithLoggingOptions<T> = {},
): CallableHandler<T, R> {
  return (async (data, context) => {
    try {
      return await handler(data, context)
    } catch (error) {
      const resolvedStoreId = await safelyResolveStoreId(options.resolveStoreId, data, context, error)
      await logCallableError({ route, context, data, error, storeId: resolvedStoreId ?? undefined })
      throw error
    }
  })
}

export { sanitizePayload }

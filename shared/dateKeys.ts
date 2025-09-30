const DATE_KEY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cacheKey = timeZone || 'UTC'
  let formatter = formatterCache.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: cacheKey,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatterCache.set(cacheKey, formatter)
  }
  return formatter
}

export type FormatDateKeyOptions = {
  timeZone?: string
  onInvalidTimeZone?: (timeZone: string, error: unknown) => void
}

export function formatDailySummaryKey(date: Date, options: FormatDateKeyOptions = {}): string {
  const { timeZone = 'UTC', onInvalidTimeZone } = options

  try {
    return getFormatter(timeZone).format(date)
  } catch (error) {
    if (timeZone !== 'UTC') {
      formatterCache.delete(timeZone)
      onInvalidTimeZone?.(timeZone, error)
      return getFormatter('UTC').format(date)
    }
    throw error
  }
}

export function parseDailySummaryKey(value: string): Date | null {
  if (typeof value !== 'string') return null
  const match = value.match(DATE_KEY_REGEX)
  if (!match) return null
  const [, yearStr, monthStr, dayStr] = match
  const year = Number(yearStr)
  const monthIndex = Number(monthStr) - 1
  const day = Number(dayStr)
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day)) {
    return null
  }
  const date = new Date(Date.UTC(year, monthIndex, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

export function normalizeDailySummaryKey(value: string): string | null {
  const parsed = parseDailySummaryKey(value)
  if (!parsed) return null
  return formatDailySummaryKey(parsed, { timeZone: 'UTC' })
}

import * as functions from 'firebase-functions'
import { google, sheets_v4 } from 'googleapis'

const DEFAULT_SPREADSHEET_ID = '1_oqRHePaZnpULD9zRUtxBIHQUaHccGAxSP3SPCJ0o7g'
const DEFAULT_RANGE = 'Clients!A:ZZ'
const EMAIL_HEADER_MATCHERS = new Set([
  'email',
  'user_email',
  'login_email',
  'primary_email',
  'member_email',
])

export type SheetRowRecord = {
  spreadsheetId: string
  headers: string[]
  normalizedHeaders: string[]
  values: string[]
  record: Record<string, string>
}

let sheetsClientPromise: Promise<sheets_v4.Sheets> | null = null

type ServiceAccountConfig = {
  client_email: string
  private_key: string
}

type SheetsConfig = {
  service_account?: string | ServiceAccountConfig
  range?: string
  spreadsheet_id?: string
}

export function normalizeHeader(header: unknown): string {
  if (typeof header !== 'string') return ''
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function decodeServiceAccount(raw: string | ServiceAccountConfig | undefined | null): ServiceAccountConfig {
  if (!raw) {
    throw new Error('Missing Sheets service account credentials')
  }

  let parsed: ServiceAccountConfig | null = null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      throw new Error('Sheets service account credentials are empty')
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error('Sheets service account credentials must be valid JSON')
    }
  } else if (typeof raw === 'object') {
    parsed = raw
  }

  if (!parsed || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error('Sheets service account credentials are incomplete')
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  }
}

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (!sheetsClientPromise) {
    const config = (functions.config()?.sheets ?? {}) as SheetsConfig
    const envCredentials = process.env.SHEETS_SERVICE_ACCOUNT
    const credentialsSource = config.service_account ?? envCredentials
    const credentials = decodeServiceAccount(credentialsSource ?? null)
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const authClientPromise = auth.getClient()
    sheetsClientPromise = (async () => {
      const authClient = await authClientPromise
      return google.sheets({ version: 'v4', auth: authClient })
    })()
  }

  return sheetsClientPromise
}

function buildRecord(headers: string[], row: unknown[]): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((header, index) => {
    if (!header) return
    const value = row[index]
    if (typeof value === 'string') {
      record[header] = value.trim()
    } else if (value === undefined || value === null) {
      record[header] = ''
    } else {
      record[header] = String(value).trim()
    }
  })
  return record
}

function resolveRange(config: SheetsConfig): string {
  const configuredRange = typeof config.range === 'string' ? config.range.trim() : ''
  if (configuredRange) return configuredRange
  return DEFAULT_RANGE
}

function resolveSpreadsheetId(config: SheetsConfig, sheetId: string | null | undefined): string {
  const explicit = typeof sheetId === 'string' ? sheetId.trim() : ''
  if (explicit) return explicit
  const configured = typeof config.spreadsheet_id === 'string' ? config.spreadsheet_id.trim() : ''
  if (configured) return configured
  return DEFAULT_SPREADSHEET_ID
}

function isMatchingEmail(value: unknown, target: string): boolean {
  if (typeof value !== 'string') return false
  return value.trim().toLowerCase() === target
}

function isEmailHeader(header: string): boolean {
  if (!header) return false
  if (EMAIL_HEADER_MATCHERS.has(header)) return true
  return header.endsWith('_email') || header.includes('email')
}

export async function fetchClientRowByEmail(sheetId: string | null | undefined, email: string): Promise<SheetRowRecord | null> {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!normalizedEmail) {
    return null
  }

  const config = (functions.config()?.sheets ?? {}) as SheetsConfig
  const range = resolveRange(config)
  const spreadsheetId = resolveSpreadsheetId(config, sheetId)

  const sheets = await getSheetsClient()
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'ROWS',
  })

  const rows = (response.data.values ?? []) as unknown[][]
  if (!rows.length) return null

  const headerRow = (rows[0] ?? []) as unknown[]
  const headers = headerRow.map(cell =>
    typeof cell === 'string' ? cell : cell === undefined || cell === null ? '' : String(cell),
  )
  const normalizedHeaders = headers.map(normalizeHeader)
  const emailColumns = normalizedHeaders
    .map((header, index) => (isEmailHeader(header) ? index : -1))
    .filter(index => index >= 0)

  if (!emailColumns.length) {
    throw new Error('No email column found in Google Sheet')
  }

  for (let i = 1; i < rows.length; i += 1) {
    const rowValues = rows[i]
    if (!Array.isArray(rowValues)) continue
    const hasMatch = emailColumns.some(columnIndex => isMatchingEmail(rowValues[columnIndex], normalizedEmail))
    if (!hasMatch) continue

    const record = buildRecord(normalizedHeaders, rowValues)
    return {
      spreadsheetId,
      headers,
      normalizedHeaders,
      values: rowValues.map(value => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))),
      record,
    }
  }

  return null
}

export function getDefaultSpreadsheetId() {
  const config = (functions.config()?.sheets ?? {}) as SheetsConfig
  return resolveSpreadsheetId(config, null)
}

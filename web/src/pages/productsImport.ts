import type { ProductRecord } from './Products'

export interface ProductImportRow {
  name: string
  sku: string
  price: number
  reorderThreshold: number | null
  stockCount: number | null
  sourceIndex: number
}

export interface ProductCsvNormalizationResult {
  rows: ProductImportRow[]
  skipped: number
  errors: string[]
  total: number
}

export interface ProductImportPayload {
  name: string
  sku: string
  price: number
  reorderThreshold: number | null
  stockCount: number | null
}

export type ProductImportOperation =
  | { type: 'create'; payload: ProductImportPayload; sku: string; sourceIndex: number }
  | { type: 'update'; payload: ProductImportPayload; id: string; sku: string; sourceIndex: number }

const OPTIONAL_REORDER_HEADERS = new Set(['reorderthreshold', 'reorderpoint', 'reorderlevel'])
const OPTIONAL_STOCK_HEADERS = new Set(['stockcount', 'stockonhand', 'onhand', 'quantity'])

function normalizeHeaderName(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function parsePositiveNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = Number(trimmed.replace(/,/g, ''))
  if (!Number.isFinite(normalized)) return null
  if (normalized < 0) return null
  return normalized
}

export function normalizeProductCsvRows(rows: string[][]): ProductCsvNormalizationResult {
  if (!rows.length) {
    return { rows: [], skipped: 0, errors: [], total: 0 }
  }

  const [header, ...dataRows] = rows
  const normalizedHeaders = header.map(cell => normalizeHeaderName(cell))

  const nameIndex = normalizedHeaders.indexOf('name')
  const skuIndex = normalizedHeaders.indexOf('sku')
  const priceIndex = normalizedHeaders.indexOf('price')

  if (nameIndex < 0 || skuIndex < 0 || priceIndex < 0) {
    throw new Error('"Name", "SKU", and "Price" columns are required to import products.')
  }

  const reorderIndex = normalizedHeaders.findIndex(value => OPTIONAL_REORDER_HEADERS.has(value))
  const stockIndex = normalizedHeaders.findIndex(value => OPTIONAL_STOCK_HEADERS.has(value))

  const validRows: ProductImportRow[] = []
  const errors: string[] = []
  let consideredRows = 0

  dataRows.forEach((rawRow, rowOffset) => {
    const row = rawRow.map(cell => (cell ?? '').trim())
    if (row.every(cell => cell.length === 0)) {
      return
    }

    consideredRows += 1
    const rowNumber = rowOffset + 2

    const name = row[nameIndex] ?? ''
    if (!name) {
      errors.push(`Row ${rowNumber}: Missing product name.`)
      return
    }

    const sku = row[skuIndex] ?? ''
    if (!sku) {
      errors.push(`Row ${rowNumber}: Missing SKU.`)
      return
    }

    const priceValue = row[priceIndex] ?? ''
    const price = parsePositiveNumber(priceValue)
    if (price === null) {
      errors.push(`Row ${rowNumber}: Invalid price.`)
      return
    }

    let reorderThreshold: number | null = null
    if (reorderIndex >= 0) {
      const reorderValue = row[reorderIndex] ?? ''
      if (reorderValue) {
        const parsed = parsePositiveNumber(reorderValue)
        if (parsed === null) {
          errors.push(`Row ${rowNumber}: Invalid reorder point.`)
          return
        }
        reorderThreshold = parsed
      } else {
        reorderThreshold = null
      }
    }

    let stockCount: number | null = null
    if (stockIndex >= 0) {
      const stockValue = row[stockIndex] ?? ''
      if (stockValue) {
        const parsed = parsePositiveNumber(stockValue)
        if (parsed === null) {
          errors.push(`Row ${rowNumber}: Invalid stock count.`)
          return
        }
        stockCount = parsed
      } else {
        stockCount = null
      }
    }

    validRows.push({
      name,
      sku,
      price,
      reorderThreshold,
      stockCount,
      sourceIndex: rowNumber,
    })
  })

  return {
    rows: validRows,
    skipped: errors.length,
    errors,
    total: consideredRows,
  }
}

function buildPayload(row: ProductImportRow): ProductImportPayload {
  return {
    name: row.name,
    sku: row.sku,
    price: row.price,
    reorderThreshold: row.reorderThreshold,
    stockCount: row.stockCount,
  }
}

export function buildProductImportOperations({
  rows,
  existingProducts,
}: {
  rows: ProductImportRow[]
  existingProducts: Pick<ProductRecord, 'id' | 'sku'>[]
}): {
  operations: ProductImportOperation[]
  counts: { toCreate: number; toUpdate: number }
} {
  const operations: ProductImportOperation[] = []
  const existingBySku = new Map<string, Pick<ProductRecord, 'id' | 'sku'>>()

  existingProducts.forEach(product => {
    const sku = (product.sku ?? '').trim()
    if (!sku) return
    existingBySku.set(sku.toLowerCase(), product)
  })

  rows.forEach(row => {
    const skuKey = row.sku.trim().toLowerCase()
    const payload = buildPayload(row)
    const existing = existingBySku.get(skuKey)
    if (existing) {
      operations.push({ type: 'update', id: existing.id, payload, sku: row.sku, sourceIndex: row.sourceIndex })
    } else {
      operations.push({ type: 'create', payload, sku: row.sku, sourceIndex: row.sourceIndex })
    }
  })

  const toCreate = operations.filter(operation => operation.type === 'create').length
  const toUpdate = operations.length - toCreate

  return {
    operations,
    counts: { toCreate, toUpdate },
  }
}

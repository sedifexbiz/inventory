import { describe, expect, it } from 'vitest'
import {
  buildProductImportOperations,
  normalizeProductCsvRows,
  type ProductImportRow,
} from '../productsImport'

describe('normalizeProductCsvRows', () => {
  it('normalizes valid product rows with optional values', () => {
    const rows = [
      ['Name', 'SKU', 'Price', 'Reorder Threshold', 'Stock Count'],
      ['House Blend Coffee', 'HB-01', '12.5', '3', '25'],
      ['Breakfast Tea', 'BT-02', '8', '', ''],
    ]

    const result = normalizeProductCsvRows(rows)

    expect(result.total).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([])

    const expected: ProductImportRow[] = [
      {
        name: 'House Blend Coffee',
        sku: 'HB-01',
        price: 12.5,
        reorderThreshold: 3,
        stockCount: 25,
        sourceIndex: 2,
      },
      {
        name: 'Breakfast Tea',
        sku: 'BT-02',
        price: 8,
        reorderThreshold: null,
        stockCount: null,
        sourceIndex: 3,
      },
    ]

    expect(result.rows).toEqual(expected)
  })

  it('skips invalid rows and surfaces descriptive errors', () => {
    const rows = [
      ['Name', 'SKU', 'Price', 'Reorder Point', 'Stock On Hand'],
      ['Espresso Beans', 'EB-10', '18.75', '5', 'abc'],
      ['', 'EB-11', '14.5', '2', '7'],
      ['Drip Filters', '', '4.5', '', '15'],
      ['Mocha Syrup', 'MS-42', '-2', '', '6'],
      ['Reusable Cup', 'RC-01', '7.25', '2', '9'],
    ]

    const result = normalizeProductCsvRows(rows)

    expect(result.total).toBe(5)
    expect(result.rows).toHaveLength(1)
    expect(result.skipped).toBe(4)
    expect(result.errors).toEqual([
      'Row 2: Invalid stock count.',
      'Row 3: Missing product name.',
      'Row 4: Missing SKU.',
      'Row 5: Invalid price.',
    ])
    expect(result.rows[0]).toMatchObject({ sku: 'RC-01', price: 7.25 })
  })
})

describe('buildProductImportOperations', () => {
  it('creates update and create operations based on SKU matches', () => {
    const rows: ProductImportRow[] = [
      {
        name: 'House Blend Coffee',
        sku: 'HB-01',
        price: 12.5,
        reorderThreshold: 3,
        stockCount: 25,
        sourceIndex: 2,
      },
      {
        name: 'Breakfast Tea',
        sku: 'BT-02',
        price: 8,
        reorderThreshold: null,
        stockCount: null,
        sourceIndex: 3,
      },
    ]

    const existingProducts = [
      { id: 'prod-hb-01', sku: 'hb-01' },
      { id: 'prod-old', sku: 'OLD-99' },
    ]

    const { operations, counts } = buildProductImportOperations({ rows, existingProducts })

    expect(counts).toEqual({ toCreate: 1, toUpdate: 1 })
    expect(operations).toEqual([
      {
        type: 'update',
        id: 'prod-hb-01',
        sku: 'HB-01',
        sourceIndex: 2,
        payload: {
          name: 'House Blend Coffee',
          sku: 'HB-01',
          price: 12.5,
          reorderThreshold: 3,
          stockCount: 25,
        },
      },
      {
        type: 'create',
        sku: 'BT-02',
        sourceIndex: 3,
        payload: {
          name: 'Breakfast Tea',
          sku: 'BT-02',
          price: 8,
          reorderThreshold: null,
          stockCount: null,
        },
      },
    ])
  })
})

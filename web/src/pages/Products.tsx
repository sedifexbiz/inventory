import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { Link } from 'react-router-dom'
import { db } from '../firebase'
import { useActiveStoreContext } from '../context/ActiveStoreProvider'
import {
  PRODUCT_CACHE_LIMIT,
  loadCachedProducts,
  saveCachedProducts,
} from '../utils/offlineCache'
import { parseCsv } from '../utils/csv'
import {
  buildProductImportOperations,
  normalizeProductCsvRows,
  type ProductImportOperation,
} from './productsImport'
import './Products.css'
import { formatCurrency } from '@shared/currency'

interface ReceiptDetails {
  qty?: number | null
  supplier?: string | null
  receivedAt?: unknown
}

export type ProductRecord = {
  id: string
  name: string
  price: number | null
  sku?: string | null
  stockCount?: number | null
  reorderThreshold?: number | null
  lastReceipt?: ReceiptDetails | null
  createdAt?: unknown
  updatedAt?: unknown
  storeId?: string | null
  __optimistic?: boolean
}

type StatusTone = 'success' | 'error'

interface StatusState {
  tone: StatusTone
  message: string
}

function sanitizePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return null
}

const DEFAULT_CREATE_FORM = {
  name: '',
  sku: '',
  price: '',
  reorderThreshold: '',
  initialStock: '',
}

const DEFAULT_EDIT_FORM = {
  name: '',
  sku: '',
  price: '',
  reorderThreshold: '',
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed)
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value) : null
  }
  if (typeof value === 'object') {
    const anyValue = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number; nanoseconds?: number }
    if (typeof anyValue.toDate === 'function') {
      try {
        return anyValue.toDate() ?? null
      } catch (error) {
        console.warn('[products] Failed to convert timestamp via toDate', error)
      }
    }
    if (typeof anyValue.toMillis === 'function') {
      try {
        const millis = anyValue.toMillis()
        return Number.isFinite(millis) ? new Date(millis) : null
      } catch (error) {
        console.warn('[products] Failed to convert timestamp via toMillis', error)
      }
    }
    if (typeof anyValue.seconds === 'number') {
      const millis = anyValue.seconds * 1000 + Math.round((anyValue.nanoseconds ?? 0) / 1_000_000)
      return Number.isFinite(millis) ? new Date(millis) : null
    }
  }
  return null
}

function formatReceiptDetails(receipt: ReceiptDetails | null | undefined): string {
  if (!receipt) return 'No receipts recorded'
  const qty = typeof receipt.qty === 'number' ? receipt.qty : null
  const supplier = typeof receipt.supplier === 'string' ? receipt.supplier : null
  const receivedAt = toDate(receipt.receivedAt)
  const parts: string[] = []
  if (qty !== null) {
    parts.push(`${qty} received`)
  }
  if (supplier) {
    parts.push(`from ${supplier}`)
  }
  if (receivedAt) {
    parts.push(`on ${receivedAt.toLocaleDateString()} ${receivedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
  }
  if (!parts.length) {
    return 'Last receipt details unavailable'
  }
  return parts.join(' ')
}

function sortProducts(products: ProductRecord[]): ProductRecord[] {
  return [...products].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

function isOfflineError(error: unknown) {
  if (!navigator.onLine) return true
  if (error instanceof FirebaseError) {
    const code = (error.code || '').toLowerCase()
    return (
      code === 'unavailable' ||
      code === 'internal' ||
      code.endsWith('/unavailable') ||
      code.endsWith('/internal')
    )
  }
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase()
    return message.includes('network') || message.includes('fetch')
  }
  return false
}

export default function Products() {
  const { storeId: activeStoreId, storeChangeToken } = useActiveStoreContext()
  const [products, setProducts] = useState<ProductRecord[]>([])
  const [isLoadingProducts, setIsLoadingProducts] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [showLowStockOnly, setShowLowStockOnly] = useState(false)
  const [createForm, setCreateForm] = useState(DEFAULT_CREATE_FORM)
  const [createStatus, setCreateStatus] = useState<StatusState | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [editForm, setEditForm] = useState(DEFAULT_EDIT_FORM)
  const [editStatus, setEditStatus] = useState<StatusState | null>(null)
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<StatusState | null>(null)

  useEffect(() => {
    setProducts([])
    setLoadError(null)

    let cancelled = false

    if (!activeStoreId) {
      setProducts([])
      setIsLoadingProducts(false)
      return () => {
        cancelled = true
      }
    }

    setIsLoadingProducts(true)

    loadCachedProducts<Omit<ProductRecord, '__optimistic'>>({ storeId: activeStoreId })
      .then(cached => {
        if (!cancelled && cached.length) {
          setProducts(prev => {
            const sanitized = cached.map(item => ({
              ...(item as ProductRecord),
              price: sanitizePrice((item as ProductRecord).price),
              __optimistic: false,
              storeId: activeStoreId,
            }))
            const sanitizedIds = new Set(sanitized.map(item => item.id))
            const preserved = prev.filter(
              item =>
                item.storeId === activeStoreId &&
                (item.__optimistic || !sanitizedIds.has(item.id)),
            )
            return sortProducts([...sanitized, ...preserved])
          })
          setIsLoadingProducts(false)
        }
      })
      .catch(error => {
        console.warn('[products] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', activeStoreId),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsubscribe = onSnapshot(
      q,
      snapshot => {
        if (cancelled) return
        const rows = snapshot.docs.map(docSnap => ({
          id: docSnap.id,
          ...(docSnap.data() as Record<string, unknown>),
        }))
        const sanitizedRows = rows.map(row => ({
          ...(row as ProductRecord),
          price: sanitizePrice((row as ProductRecord).price),
          storeId: activeStoreId,
          __optimistic: false,
        }))
        saveCachedProducts(sanitizedRows, { storeId: activeStoreId }).catch(error => {
          console.warn('[products] Failed to cache products', error)
        })
        setProducts(prev => {
          const optimistic = prev.filter(
            product => product.__optimistic && product.storeId === activeStoreId,
          )
          const optimisticRemainders = optimistic.filter(
            item => !rows.some(row => row.id === item.id),
          )
          return sortProducts([...sanitizedRows, ...optimisticRemainders])
        })
        setIsLoadingProducts(false)
      },
      error => {
        if (cancelled) return
        console.error('[products] Failed to subscribe to products', error)
        setLoadError('Unable to load products right now. Please try again shortly.')
        setIsLoadingProducts(false)
      },
    )

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeStoreId, storeChangeToken])

  useEffect(() => {
    setFilterText('')
    setShowLowStockOnly(false)
    setCreateForm(DEFAULT_CREATE_FORM)
    setCreateStatus(null)
    setEditForm(DEFAULT_EDIT_FORM)
    setEditStatus(null)
    setEditingProductId(null)
    setImportStatus(null)
    setIsImporting(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [storeChangeToken])

  useEffect(() => {
    if (!editingProductId) {
      setEditForm(DEFAULT_EDIT_FORM)
      return
    }
    const product = products.find(item => item.id === editingProductId)
    if (!product) return
    setEditForm({
      name: product.name ?? '',
      sku: product.sku ?? '',
      price:
        typeof product.price === 'number' && Number.isFinite(product.price)
          ? String(product.price)
          : '',
      reorderThreshold:
        typeof product.reorderThreshold === 'number' && Number.isFinite(product.reorderThreshold)
          ? String(product.reorderThreshold)
          : '',
    })
  }, [editingProductId, products])

  const filteredProducts = useMemo(() => {
    const normalizedQuery = filterText.trim().toLowerCase()
    return sortProducts(
      products.filter(product => {
        const stockCount = typeof product.stockCount === 'number' ? product.stockCount : 0
        const reorder = typeof product.reorderThreshold === 'number' ? product.reorderThreshold : null
        const matchesLowStock = !showLowStockOnly || (reorder !== null && stockCount <= reorder)
        if (!matchesLowStock) return false
        if (!normalizedQuery) return true
        const haystack = `${product.name ?? ''} ${product.sku ?? ''}`.toLowerCase()
        return haystack.includes(normalizedQuery)
      }),
    )
  }, [filterText, products, showLowStockOnly])

  function handleCreateFieldChange(event: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setCreateForm(prev => ({ ...prev, [name]: value }))
  }

  function handleEditFieldChange(event: React.ChangeEvent<HTMLInputElement>) {
    const { name, value } = event.target
    setEditForm(prev => ({ ...prev, [name]: value }))
  }

  function resetCreateForm() {
    setCreateForm(DEFAULT_CREATE_FORM)
  }

  function validateNumbers(value: string, allowZero = true) {
    if (!value.trim()) return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 0) return null
    if (!allowZero && parsed === 0) return null
    return parsed
  }

  function parsePriceInput(value: string) {
    if (!value.trim()) return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 0) return null
    return parsed
  }

  async function handleCreateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = createForm.name.trim()
    const sku = createForm.sku.trim()
    const price = parsePriceInput(createForm.price)
    const reorderThreshold = validateNumbers(createForm.reorderThreshold)
    const initialStock = validateNumbers(createForm.initialStock)

    if (!name) {
      setCreateStatus({ tone: 'error', message: 'Name your product so the team recognises it on the shelf.' })
      return
    }
    if (price === null) {
      setCreateStatus({ tone: 'error', message: 'Enter a valid price that is zero or greater.' })
      return
    }
    if (!sku) {
      setCreateStatus({
        tone: 'error',
        message: 'Add a SKU that matches the barcode so you can scan it during checkout.',
      })
      return
    }
    if (createForm.reorderThreshold && reorderThreshold === null) {
      setCreateStatus({ tone: 'error', message: 'Enter a valid reorder point that is zero or greater.' })
      return
    }
    if (createForm.initialStock && initialStock === null) {
      setCreateStatus({ tone: 'error', message: 'Enter a valid opening stock that is zero or greater.' })
      return
    }

    if (!activeStoreId) {
      setCreateStatus({ tone: 'error', message: 'Select a workspace before adding products.' })
      return
    }

    const optimisticProduct: ProductRecord = {
      id: `optimistic-${Date.now()}`,
      name,
      price,
      sku,
      reorderThreshold: reorderThreshold ?? null,
      stockCount: initialStock ?? 0,
      lastReceipt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      storeId: activeStoreId,
      __optimistic: true,
    }

    setIsCreating(true)
    setCreateStatus(null)
    setProducts(prev => sortProducts([optimisticProduct, ...prev]))

    try {
      const ref = await addDoc(collection(db, 'products'), {
        name,
        price,
        sku,
        reorderThreshold: reorderThreshold ?? null,
        stockCount: initialStock ?? 0,
        storeId: activeStoreId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })

      setProducts(prev =>
        prev.map(product =>
          product.id === optimisticProduct.id
            ? { ...product, id: ref.id, __optimistic: false }
            : product,
        ),
      )
      setCreateStatus({ tone: 'success', message: 'Product created successfully.' })
      resetCreateForm()
    } catch (error) {
      console.error('[products] Failed to create product', error)
      if (isOfflineError(error)) {
        setProducts(prev =>
          prev.map(product =>
            product.id === optimisticProduct.id
              ? { ...product, __optimistic: true, storeId: activeStoreId }
              : product,
          ),
        )
        setCreateStatus({
          tone: 'success',
          message: 'Offline — product saved locally and will sync when you reconnect.',
        })
        return
      }
      setProducts(prev => prev.filter(product => product.id !== optimisticProduct.id))
      setCreateStatus({ tone: 'error', message: 'Unable to create product. Please try again.' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleUpdateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingProductId) {
      setEditStatus({ tone: 'error', message: 'Select a product to edit before saving.' })
      return
    }
    const name = editForm.name.trim()
    const sku = editForm.sku.trim()
    const price = parsePriceInput(editForm.price)
    const reorderThreshold = validateNumbers(editForm.reorderThreshold)

    if (!name) {
      setEditStatus({ tone: 'error', message: 'Name your product so staff know what to pick.' })
      return
    }
    if (price === null) {
      setEditStatus({ tone: 'error', message: 'Enter a valid price that is zero or greater.' })
      return
    }
    if (!sku) {
      setEditStatus({
        tone: 'error',
        message: 'Every product needs a SKU that matches its barcode for scanning.',
      })
      return
    }
    if (editForm.reorderThreshold && reorderThreshold === null) {
      setEditStatus({ tone: 'error', message: 'Enter a valid reorder point that is zero or greater.' })
      return
    }

    if (!activeStoreId) {
      setEditStatus({ tone: 'error', message: 'Select a workspace before updating products.' })
      return
    }

    const previous = products.find(product => product.id === editingProductId)
    if (!previous) {
      setEditStatus({ tone: 'error', message: 'We could not find this product to update.' })
      return
    }

    const updatedValues: Partial<ProductRecord> = {
      name,
      price,
      sku,
      reorderThreshold: reorderThreshold ?? null,
      updatedAt: new Date(),
      storeId: activeStoreId,
    }

    setIsUpdating(true)
    setEditStatus(null)
    setProducts(prev =>
      sortProducts(
        prev.map(product =>
          product.id === editingProductId
            ? { ...product, ...updatedValues, __optimistic: true }
            : product,
        ),
      ),
    )

    try {
      await updateDoc(doc(collection(db, 'products'), editingProductId), {
        name,
        price,
        sku,
        reorderThreshold: reorderThreshold ?? null,
        storeId: activeStoreId,
        updatedAt: serverTimestamp(),
      })
      setEditStatus({ tone: 'success', message: 'Product details updated.' })
      setProducts(prev =>
        prev.map(product =>
          product.id === editingProductId ? { ...product, __optimistic: false } : product,
        ),
      )
      setEditingProductId(null)
    } catch (error) {
      console.error('[products] Failed to update product', error)
      setProducts(prev =>
        prev.map(product =>
          product.id === editingProductId ? previous : product,
        ),
      )
      if (isOfflineError(error)) {
        setEditStatus({
          tone: 'success',
          message: 'Offline — product edits saved and will sync when you reconnect.',
        })
        setEditingProductId(null)
        return
      }
      setEditStatus({ tone: 'error', message: 'Unable to update product. Please try again.' })
    } finally {
      setIsUpdating(false)
    }
  }

  function isCreateOperation(
    operation: ProductImportOperation,
  ): operation is Extract<ProductImportOperation, { type: 'create' }> {
    return operation.type === 'create'
  }

  function buildCreatePayload(
    operation: Extract<ProductImportOperation, { type: 'create' }>,
    storeId: string,
  ) {
    return {
      name: operation.payload.name,
      price: operation.payload.price,
      sku: operation.payload.sku,
      reorderThreshold: operation.payload.reorderThreshold ?? null,
      stockCount: operation.payload.stockCount ?? 0,
      storeId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
  }

  function buildUpdatePayload(
    operation: Extract<ProductImportOperation, { type: 'update' }>,
    storeId: string,
  ) {
    const payload: Record<string, unknown> = {
      name: operation.payload.name,
      price: operation.payload.price,
      sku: operation.payload.sku,
      reorderThreshold: operation.payload.reorderThreshold ?? null,
      storeId,
      updatedAt: serverTimestamp(),
    }

    if (operation.payload.stockCount !== null) {
      payload.stockCount = operation.payload.stockCount
    }

    return payload
  }

  async function handleProductCsvImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    setImportStatus(null)

    try {
      if (!activeStoreId) {
        throw new Error('Select a workspace before importing products.')
      }

      const text = await file.text()
      const rows = parseCsv(text)
      if (!rows.length) {
        throw new Error('No rows detected in the file.')
      }

      const normalization = normalizeProductCsvRows(rows)
      const { rows: normalizedRows, skipped, errors, total } = normalization
      if (!normalizedRows.length) {
        const message = errors[0] ?? 'No valid product rows were found in this file.'
        throw new Error(message)
      }

      const storeProducts = products.filter(product => product.storeId === activeStoreId)
      const { operations, counts } = buildProductImportOperations({
        rows: normalizedRows,
        existingProducts: storeProducts,
      })

      if (!operations.length) {
        const message = errors[0] ?? 'No valid product rows were found in this file.'
        throw new Error(message)
      }

      const BATCH_LIMIT = 400
      let completedCreates = 0
      let completedUpdates = 0
      let offlineFallbackUsed = false
      let index = 0

      while (index < operations.length) {
        const chunk = operations.slice(index, index + BATCH_LIMIT)
        const createCount = chunk.filter(isCreateOperation).length
        const updateCount = chunk.length - createCount
        const batch = writeBatch(db)

        chunk.forEach(operation => {
          if (isCreateOperation(operation)) {
            const ref = doc(collection(db, 'products'))
            batch.set(ref, buildCreatePayload(operation, activeStoreId))
          } else {
            batch.update(doc(db, 'products', operation.id), buildUpdatePayload(operation, activeStoreId))
          }
        })

        try {
          await batch.commit()
          completedCreates += createCount
          completedUpdates += updateCount
        } catch (error) {
          if (isOfflineError(error)) {
            offlineFallbackUsed = true
            for (let j = index; j < operations.length; j += 1) {
              const operation = operations[j]
              try {
                if (isCreateOperation(operation)) {
                  await addDoc(collection(db, 'products'), buildCreatePayload(operation, activeStoreId))
                  completedCreates += 1
                } else {
                  await updateDoc(doc(db, 'products', operation.id), buildUpdatePayload(operation, activeStoreId))
                  completedUpdates += 1
                }
              } catch (fallbackError) {
                if (isOfflineError(fallbackError)) {
                  if (operation.type === 'create') {
                    completedCreates += 1
                  } else {
                    completedUpdates += 1
                  }
                } else {
                  console.error('[products] Failed to import products', fallbackError)
                  setImportStatus({
                    tone: 'error',
                    message: 'We were unable to import products from this file.',
                  })
                  return
                }
              }
            }
            index = operations.length
            break
          }

          const processed = completedCreates + completedUpdates
          console.error('[products] Failed to import products', error)
          let message = processed
            ? `Imported ${processed} product${processed === 1 ? '' : 's'} before we hit an error. Please review the file and try again.`
            : 'We were unable to import products from this file.'
          if (skipped > 0) {
            message += ` Skipped ${skipped} row${skipped === 1 ? '' : 's'} due to formatting issues.`
          }
          if (errors[0]) {
            message += ` First skipped row: ${errors[0]}.`
          }
          setImportStatus({ tone: 'error', message })
          return
        }

        index += chunk.length
      }

      const finalCreates = offlineFallbackUsed ? counts.toCreate : completedCreates
      const finalUpdates = offlineFallbackUsed ? counts.toUpdate : completedUpdates
      const processedRows = finalCreates + finalUpdates
      const totalRows = total || processedRows + skipped
      const skippedRows = Math.max(skipped, totalRows - processedRows)

      const prefix = offlineFallbackUsed
        ? 'Offline — product import saved and will sync when you reconnect.'
        : 'Imported products successfully.'

      let message = `${prefix} Processed ${processedRows} of ${totalRows} row${totalRows === 1 ? '' : 's'} (${finalCreates} added, ${finalUpdates} updated).`
      if (skippedRows > 0) {
        message += ` Skipped ${skippedRows} row${skippedRows === 1 ? '' : 's'} due to formatting issues.`
        if (errors[0]) {
          message += ` First skipped row: ${errors[0]}.`
        }
      }

      setImportStatus({ tone: 'success', message })
    } catch (error) {
      console.error('[products] Unable to import CSV', error)
      const message = error instanceof Error ? error.message : 'We were unable to import products from this file.'
      setImportStatus({ tone: 'error', message })
    } finally {
      setIsImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  function renderStatus(status: StatusState | null) {
    if (!status) return null
    return (
      <div className={`products-page__status products-page__status--${status.tone}`} role="status">
        {status.message}
      </div>
    )
  }


  return (
    <div className="page products-page">
      <header className="page__header">
        <div>
          <h2 className="page__title">Products</h2>
          <p className="page__subtitle">
            Review inventory, monitor low stock alerts, and keep your catalogue tidy.
          </p>
        </div>
        <Link to="/receive" className="products-page__receive-link">
          Receive stock
        </Link>
      </header>

      <section className="card products-page__card">
        <div className="products-page__toolbar">
          <div className="products-page__toolbar-left">
            <label className="products-page__search">
              <span className="products-page__search-label">Search</span>
              <input
                type="search"
                placeholder="Search by product or SKU"
                value={filterText}
                onChange={event => setFilterText(event.target.value)}
              />
            </label>
            <label className="products-page__filter">
              <input
                type="checkbox"
                checked={showLowStockOnly}
                onChange={event => setShowLowStockOnly(event.target.checked)}
              />
              <span>Show low stock only</span>
            </label>
          </div>
          <div className="products-page__tool-buttons">
            <button
              type="button"
              className="button button--outline button--small"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              {isImporting ? 'Importing…' : 'Import CSV'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="products-page__import-input"
              onChange={handleProductCsvImport}
            />
          </div>
        </div>
        {renderStatus(importStatus)}
        {loadError ? <div className="products-page__error">{loadError}</div> : null}
        {isLoadingProducts ? <div className="products-page__loading">Loading products…</div> : null}
        {!isLoadingProducts && filteredProducts.length === 0 ? (
          <div className="products-page__empty" role="status">
            No products found. Add your first item so you can track inventory.
          </div>
        ) : null}
        {filteredProducts.length > 0 ? (
          <div className="products-page__table-wrapper">
            <table className="products-page__table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Price</th>
                  <th scope="col">On hand</th>
                  <th scope="col">Reorder point</th>
                  <th scope="col">Last receipt</th>
                  <th scope="col" className="products-page__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map(product => {
                  const stockCount = typeof product.stockCount === 'number' ? product.stockCount : 0
                  const reorderThreshold =
                    typeof product.reorderThreshold === 'number' ? product.reorderThreshold : null
                  const isLowStock = reorderThreshold !== null && stockCount <= reorderThreshold
                  return (
                    <tr key={product.id} data-testid={`product-row-${product.id}`}>
                      <th scope="row">
                        <div className="products-page__product-name">
                          {product.name}
                          {product.__optimistic ? (
                            <span className="products-page__badge">Syncing…</span>
                          ) : null}
                          {isLowStock ? (
                            <span className="products-page__badge products-page__badge--alert">Low stock</span>
                          ) : null}
                        </div>
                      </th>
                      <td>{product.sku || '—'}</td>
                      <td>{
                        typeof product.price === 'number' && Number.isFinite(product.price)
                          ? formatCurrency(product.price)
                          : '—'
                      }</td>
                      <td>{stockCount}</td>
                      <td>{reorderThreshold ?? '—'}</td>
                      <td>{formatReceiptDetails(product.lastReceipt)}</td>
                      <td className="products-page__actions">
                        <button
                          type="button"
                          className="products-page__edit-button"
                          onClick={() => setEditingProductId(product.id)}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card products-page__card">
        <h3 className="card__title">Add product</h3>
        <p className="card__subtitle">
          Capture items you stock so sales and receipts stay accurate. Give each one a SKU that
          matches the barcode you plan to scan at checkout.
        </p>
        <form className="products-page__form" onSubmit={handleCreateProduct}>
          <label className="field">
            <span className="field__label">Name</span>
            <input
              name="name"
              value={createForm.name}
              onChange={handleCreateFieldChange}
              placeholder="e.g. House Blend Coffee"
              required
            />
          </label>
          <label className="field">
            <span className="field__label">SKU</span>
            <input
              name="sku"
              value={createForm.sku}
              onChange={handleCreateFieldChange}
              placeholder="Barcode or SKU"
              required
              aria-describedby="create-sku-hint"
            />
          </label>
          <p className="field__hint" id="create-sku-hint">
            This must match the value encoded in your barcode so cashiers can scan products.
          </p>
          <label className="field">
            <span className="field__label">Price</span>
            <input
              name="price"
              value={createForm.price}
              onChange={handleCreateFieldChange}
              placeholder="How much you sell it for"
              inputMode="decimal"
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Reorder point</span>
            <input
              name="reorderThreshold"
              value={createForm.reorderThreshold}
              onChange={handleCreateFieldChange}
              placeholder="Alert when stock drops to…"
              inputMode="numeric"
            />
          </label>
          <label className="field">
            <span className="field__label">Opening stock</span>
            <input
              name="initialStock"
              value={createForm.initialStock}
              onChange={handleCreateFieldChange}
              placeholder="Quantity currently on hand"
              inputMode="numeric"
            />
          </label>
          <button type="submit" className="products-page__submit" disabled={isCreating}>
            {isCreating ? 'Saving…' : 'Add product'}
          </button>
          {renderStatus(createStatus)}
        </form>
      </section>

      {editingProductId ? (
        <div className="products-page__dialog" role="dialog" aria-modal="true">
          <div className="products-page__dialog-content">
            <h3>Edit product</h3>
            <form className="products-page__form" onSubmit={handleUpdateProduct}>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  name="name"
                  value={editForm.name}
                  onChange={handleEditFieldChange}
                  required
                />
              </label>
              <label className="field">
                <span className="field__label">SKU</span>
                <input
                  name="sku"
                  value={editForm.sku}
                  onChange={handleEditFieldChange}
                  required
                  aria-describedby="edit-sku-hint"
                />
              </label>
              <p className="field__hint" id="edit-sku-hint">
                Update the SKU to mirror the barcode if you need to reprint or relabel items.
              </p>
              <label className="field">
                <span className="field__label">Price</span>
                <input
                  name="price"
                  value={editForm.price}
                  onChange={handleEditFieldChange}
                  inputMode="decimal"
                  required
                />
              </label>
              <label className="field">
                <span className="field__label">Reorder point</span>
                <input
                  name="reorderThreshold"
                  value={editForm.reorderThreshold}
                  onChange={handleEditFieldChange}
                  inputMode="numeric"
                />
              </label>
              <div className="products-page__dialog-actions">
                <button
                  type="button"
                  className="products-page__cancel"
                  onClick={() => setEditingProductId(null)}
                  disabled={isUpdating}
                >
                  Cancel
                </button>
                <button type="submit" className="products-page__submit" disabled={isUpdating}>
                  {isUpdating ? 'Saving…' : 'Save changes'}
                </button>
              </div>
              {renderStatus(editStatus)}
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}


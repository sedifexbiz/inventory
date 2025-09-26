import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  collection, onSnapshot, query, where, orderBy, limit,
  doc, deleteDoc, deleteField, runTransaction, serverTimestamp,
} from 'firebase/firestore'
import type { Timestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { useActiveStore } from '../hooks/useActiveStore'
import { AccessDenied } from '../components/AccessDenied'
import { canAccessFeature } from '../utils/permissions'
import './Products.css'
import { loadCachedProducts, saveCachedProducts, PRODUCT_CACHE_LIMIT } from '../utils/offlineCache'
import { buildSimplePdf } from '../utils/pdf'

type FirestoreDate = ReturnType<typeof serverTimestamp> | Timestamp | Date | number | null

type Product = {
  id?: string
  storeId: string
  name: string
  price: number
  stockCount?: number
  barcode?: string
  minStock?: number
  createdAt?: FirestoreDate
  updatedAt?: FirestoreDate
}

/* ---------------- Scanner modal (isolates hooks) ---------------- */

type ScannerProps = {
  mode: 'new' | 'edit'
  onValue: (barcode: string) => void
  onClose: () => void
}

function ScannerModal({ mode, onValue, onClose }: ScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number>()
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanMessage, setScanMessage] = useState('Point your camera at a barcode')

  useEffect(() => {
    let cancelled = false

    async function init() {
      setScanError(null)
      setScanMessage('Point your camera at a barcode')

      const Detector = (window as any).BarcodeDetector
      if (!Detector) {
        setScanError('Barcode scanning is not supported on this device. You can still type the barcode manually.')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setScanError('Camera access is not available on this device. You can enter the barcode manually instead.')
        return
      }

      let detector: any
      try {
        detector = new Detector({
          formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf']
        })
      } catch (err) {
        console.error(err)
        setScanError('Unable to start the barcode scanner.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false
        })
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }

        setScanMessage('Looking for a barcode…')

        const detectLoop = async () => {
          if (cancelled) return
          try {
            if (!videoRef.current) return
            const barcodes = await detector.detect(videoRef.current)
            const value = barcodes[0]?.rawValue?.trim()
            if (value) {
              onValue(value)
              onClose()
              return
            }
            frameRef.current = requestAnimationFrame(detectLoop)
          } catch (error) {
            console.error(error)
            setScanError('An error occurred while scanning. You can enter the barcode manually or close this window.')
            if (frameRef.current) cancelAnimationFrame(frameRef.current)
            frameRef.current = undefined
          }
        }

        detectLoop()
      } catch (err) {
        console.error(err)
        setScanError('We could not access the camera. Please allow camera access or enter the barcode manually.')
      }
    }

    init()

    return () => {
      cancelled = true
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
        streamRef.current = null
      }
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [onClose, onValue])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="scan-modal-title">
      <div className="modal products__modal">
        <h3 id="scan-modal-title" className="modal__title">Scan barcode</h3>
        {scanError ? (
          <p className="modal__error">{scanError}</p>
        ) : (
          <>
            <video ref={videoRef} playsInline className="products__video" muted />
            <p className="modal__message" aria-live="polite">{scanMessage}</p>
          </>
        )}
        <button type="button" className="button button--primary button--block" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

/* ---------------- Main component ---------------- */

export default function Products() {
  // Keep all hooks *unconditional* and *top-level*
  const { storeId: STORE_ID, role, isLoading: storeLoading, error: storeError } = useActiveStore()

  const [items, setItems] = useState<Product[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState<string>('')
  const [barcode, setBarcode] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState<string>('')
  const [editStock, setEditStock] = useState<string>('')
  const [editBarcode, setEditBarcode] = useState('')
  const [scanMode, setScanMode] = useState<'new' | 'edit' | null>(null)
  const [shareFeedback, setShareFeedback] = useState<string | null>(null)
  const [formFeedback, setFormFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const feedbackTimeoutRef = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [stockFilter, setStockFilter] = useState<'all' | 'in-stock' | 'low-stock' | 'out-of-stock'>('all')

  const hasAccess = canAccessFeature(role, 'products')

  // cleanup for transient UI feedback timers
  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current)
        feedbackTimeoutRef.current = null
      }
    }
  }, [])

  // live products subscription
  useEffect(() => {
    if (!STORE_ID || !hasAccess) return

    let cancelled = false

    loadCachedProducts<Product>(STORE_ID)
      .then(cached => {
        if (!cancelled && cached.length) {
          setItems(
            [...cached].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
          )
        }
      })
      .catch(error => {
        console.warn('[products] Failed to load cached products', error)
      })

    const q = query(
      collection(db, 'products'),
      where('storeId', '==', STORE_ID),
      orderBy('updatedAt', 'desc'),
      orderBy('createdAt', 'desc'),
      limit(PRODUCT_CACHE_LIMIT),
    )

    const unsub = onSnapshot(q, snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as Product) }))
      saveCachedProducts(STORE_ID, rows).catch(error => {
        console.warn('[products] Failed to cache products', error)
      })
      const sortedRows = [...rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
      setItems(sortedRows)
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [STORE_ID, hasAccess])

  if (!storeLoading && !hasAccess) {
    return <AccessDenied feature="products" role={role ?? null} />
  }

  function showFormFeedback(tone: 'success' | 'error', message: string) {
    setFormFeedback({ tone, message })
    if (feedbackTimeoutRef.current) window.clearTimeout(feedbackTimeoutRef.current)
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setFormFeedback(null)
      feedbackTimeoutRef.current = null
    }, 4000)
  }

  async function addProduct(e: React.FormEvent) {
    e.preventDefault()
    if (!STORE_ID || !name || price === '') return
    setBusy(true)
    try {
      const trimmedBarcode = barcode.trim()
      const timestamp = serverTimestamp()
      const newProduct: Omit<Product, 'id'> = {
        storeId: STORE_ID,
        name,
        price: Number(price),
        stockCount: 0,
        updatedAt: timestamp,
        ...(trimmedBarcode ? { barcode: trimmedBarcode } : {})
      }
      const productRef = doc(collection(db, 'products'))
      await runTransaction(db, async tx => {
        if (trimmedBarcode) {
          const barcodeRef = doc(db, 'barcodes', `${STORE_ID}:${trimmedBarcode}`)
          const barcodeSnap = await tx.get(barcodeRef)
          if (barcodeSnap.exists()) {
            throw new Error('barcode-conflict')
          }
          tx.set(barcodeRef, {
            productId: productRef.id,
            storeId: STORE_ID,
            updatedAt: timestamp,
          })
        }
        tx.set(productRef, { ...newProduct, createdAt: timestamp })
      })
      setName('')
      setPrice('')
      setBarcode('')
      showFormFeedback('success', 'Product saved successfully.')
    } catch (error) {
      console.error('[products] Failed to add product', error)
      if (error instanceof Error && error.message === 'barcode-conflict') {
        showFormFeedback('error', 'That barcode is already assigned to another product.')
      } else {
        showFormFeedback('error', 'Unable to add product. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  function beginEdit(p: Product) {
    setEditing(p.id!)
    setEditName(p.name)
    setEditPrice(String(p.price))
    setEditStock(String(p.stockCount ?? 0))
    setEditBarcode(p.barcode ?? '')
  }

  async function saveEdit(id: string) {
    setBusy(true)
    try {
      const trimmed = editBarcode.trim()
      const productRef = doc(db, 'products', id)
      const timestamp = serverTimestamp()
      await runTransaction(db, async tx => {
        const productSnap = await tx.get(productRef)
        if (!productSnap.exists()) {
          throw new Error('missing-product')
        }
        const currentData = productSnap.data() as Product
        const currentBarcode = currentData.barcode?.trim() ?? ''

        if (currentBarcode && currentBarcode !== trimmed) {
          const oldRef = doc(db, 'barcodes', `${STORE_ID}:${currentBarcode}`)
          tx.delete(oldRef)
        }

        if (trimmed) {
          const newRef = doc(db, 'barcodes', `${STORE_ID}:${trimmed}`)
          const existingSnap = await tx.get(newRef)
          if (existingSnap.exists()) {
            const data = existingSnap.data() as { productId?: string }
            if (data.productId && data.productId !== id) {
              throw new Error('barcode-conflict')
            }
          }
          tx.set(newRef, {
            productId: id,
            storeId: STORE_ID,
            updatedAt: timestamp,
          })
        }

        const payload: Record<string, unknown> = {
          name: editName,
          price: Number(editPrice),
          stockCount: Number(editStock),
          updatedAt: timestamp,
          ...(trimmed ? { barcode: trimmed } : { barcode: deleteField() }),
        }

        tx.update(productRef, payload)
      })
      setEditing(null)
      showFormFeedback('success', 'Changes saved.')
    } catch (error) {
      console.error('[products] Failed to update product', error)
      if (error instanceof Error && error.message === 'barcode-conflict') {
        showFormFeedback('error', 'That barcode is already assigned to another product.')
      } else {
        showFormFeedback('error', 'Unable to save changes. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      await deleteDoc(doc(db, 'products', id))
      showFormFeedback('success', 'Product removed.')
      if (editing === id) setEditing(null)
    } catch (error) {
      console.error('[products] Failed to delete product', error)
      showFormFeedback('error', 'Unable to delete product. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (storeLoading) return <div>Loading…</div>
  if (!STORE_ID) {
    return <div>We were unable to determine your store access. Please sign out and back in.</div>
  }

  function stockStatus(item: Product) {
    const stock = item.stockCount ?? 0
    const minStock = item.minStock ?? 5
    if (stock <= 0) return 'out'
    if (stock <= minStock) return 'low'
    return 'ok'
  }

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return items.filter((item) => {
      const matchesTerm = term
        ? [item.name, item.barcode].filter(Boolean).some(value => value!.toLowerCase().includes(term))
        : true
      if (!matchesTerm) return false

      const stock = item.stockCount ?? 0
      const minStock = item.minStock ?? 5

      switch (stockFilter) {
        case 'in-stock':
          return stock > 0
        case 'low-stock':
          return stock > 0 && stock <= minStock
        case 'out-of-stock':
          return stock <= 0
        default:
          return true
      }
    })
  }, [items, searchTerm, stockFilter])

  const exportFile = useCallback((content: BlobPart, type: string, filename: string) => {
    if (typeof window === 'undefined') return
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    const revoke = () => {
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }
    if ('requestAnimationFrame' in window) {
      window.requestAnimationFrame(revoke)
    } else {
      setTimeout(revoke, 0)
    }
  }, [])

  const handleDownloadCsv = useCallback(() => {
    if (!filteredItems.length) return
    const header = ['Name', 'Price (GHS)', 'Stock', 'Barcode']
    const rows = filteredItems.map(item => [
      `"${item.name.replace(/"/g, '""')}"`,
      item.price?.toFixed(2) ?? '0.00',
      String(item.stockCount ?? 0),
      item.barcode ? `"${item.barcode.replace(/"/g, '""')}"` : ''
    ])
    const csv = [header.join(','), ...rows.map(row => row.join(','))].join('\n')
    exportFile(csv, 'text/csv;charset=utf-8;', 'products.csv')
  }, [exportFile, filteredItems])

  const handleDownloadPdf = useCallback(() => {
    if (!filteredItems.length) return
    const column = (value: string, length: number) => {
      if (value.length > length) return value.slice(0, length - 1) + '…'
      return value.padEnd(length, ' ')
    }
    const lines = [
      '',
      `${column('Name', 24)}${column('Price', 10)}${column('Stock', 8)}Barcode`,
      `${'-'.repeat(24)}${'-'.repeat(10)}${'-'.repeat(8)}${'-'.repeat(12)}`,
      ...filteredItems.map(item => {
        const price = `GHS ${(item.price ?? 0).toFixed(2)}`
        const stock = `${item.stockCount ?? 0}`
        const barcode = item.barcode ?? '—'
        return `${column(item.name, 24)}${column(price, 10)}${column(stock, 8)}${barcode}`
      })
    ]
    const pdfBytes = buildSimplePdf('Products Report', lines)
    const pdfBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer
    exportFile(pdfBuffer, 'application/pdf', 'products.pdf')
  }, [exportFile, filteredItems])

  const handleShare = useCallback(async () => {
    if (!filteredItems.length) return
    const summary = filteredItems
      .map(item => `${item.name} – GHS ${(item.price ?? 0).toFixed(2)} (${item.stockCount ?? 0} in stock)${item.barcode ? ` – ${item.barcode}` : ''}`)
      .join('\n')
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Product list', text: summary })
        setShareFeedback('Shared successfully')
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary)
        setShareFeedback('Copied details to clipboard')
      } else {
        exportFile(summary, 'text/plain', 'products.txt')
        setShareFeedback('Downloaded product summary')
      }
    } catch (error) {
      console.error('Failed to share product list', error)
      setShareFeedback('Unable to share right now')
    }
    setTimeout(() => setShareFeedback(null), 4000)
  }, [exportFile, filteredItems])

  return (
    <div className="page products-page" aria-busy={busy ? 'true' : 'false'}>
      <header className="page__header">
        <div>
          <h2 className="page__title">Products</h2>
          <p className="card__subtitle">Manage your Firestore catalogue, pricing, and shelf stock in one place.</p>
        </div>
        {shareFeedback && (
          <span className="feedback" role="status" aria-live="polite">{shareFeedback}</span>
        )}
      </header>

      <section className="card products__form-card" aria-label="Add a new product">
        <div>
          <h3 className="card__title">Add a product</h3>
          <p className="card__subtitle">Create items with optional barcodes so the team can scan and sell faster.</p>
        </div>
        <form onSubmit={addProduct} className="products__form">
          <div className="field">
            <label className="field__label" htmlFor="product-name">Name</label>
            <input
              id="product-name"
              placeholder="e.g. Premium bottled water"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="product-price">Price (GHS)</label>
            <input
              id="product-price"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={price}
              onChange={e => setPrice(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="product-barcode">Barcode</label>
            <div className="products__scan-input">
              <input
                id="product-barcode"
                placeholder="Optional — scan or type barcode"
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
              />
              <button
                type="button"
                className="button button--neutral button--small"
                onClick={() => setScanMode('new')}
              >
                Scan
              </button>
            </div>
          </div>
          <div className="products__form-actions">
            <button type="submit" className="button button--primary" disabled={busy}>Add product</button>
          </div>
        </form>
        {formFeedback && (
          <p
            className={`products__form-feedback products__form-feedback--${formFeedback.tone}`}
            role={formFeedback.tone === 'error' ? 'alert' : 'status'}
            aria-live={formFeedback.tone === 'error' ? 'assertive' : 'polite'}
          >
            {formFeedback.message}
          </p>
        )}
        {storeError && (
          <p className="products__form-feedback products__form-feedback--error" role="alert">
            {storeError}
          </p>
        )}
      </section>

      <section className="card products__controls">
        <div className="products__filters">
          <div className="field">
            <label className="field__label" htmlFor="product-search">Search</label>
            <input
              id="product-search"
              placeholder="Search by name or barcode"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="product-stock-filter">Stock filter</label>
            <select
              id="product-stock-filter"
              value={stockFilter}
              onChange={e => setStockFilter(e.target.value as typeof stockFilter)}
            >
              <option value="all">All stock levels</option>
              <option value="in-stock">In stock</option>
              <option value="low-stock">Low stock</option>
              <option value="out-of-stock">Out of stock</option>
            </select>
          </div>
        </div>
        <div className="products__export-actions">
          <button
            type="button"
            className="button button--primary button--small"
            onClick={handleDownloadPdf}
            disabled={!filteredItems.length}
          >
            Download PDF
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={handleDownloadCsv}
            disabled={!filteredItems.length}
          >
            Download CSV
          </button>
          <button
            type="button"
            className="button button--success button--small"
            onClick={handleShare}
            disabled={!filteredItems.length}
          >
            Share list
          </button>
        </div>
      </section>

      <section className="card card--flush">
        <div className="products__table-header">
          <div>
            <h3 className="card__title">Product catalogue</h3>
            <p className="card__subtitle">{items.length} products synced from Firestore.</p>
          </div>
        </div>
        <div className="table-wrapper">
          {filteredItems.length ? (
            <table className="table products__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="products__price-column">Price</th>
                  <th scope="col">Stock</th>
                  <th scope="col">Barcode</th>
                  <th scope="col" className="products__actions-column">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map(p => {
                  const status = stockStatus(p)
                  const stockLabel = status === 'out'
                    ? 'Out of stock'
                    : status === 'low'
                      ? 'Low stock'
                      : 'In stock'
                  const stockCount = p.stockCount ?? 0
                  return (
                    <tr key={p.id} className={`products__row${editing === p.id ? ' is-editing' : ''}`}>
                      <td>
                        {editing === p.id ? (
                          <input value={editName} onChange={e => setEditName(e.target.value)} />
                        ) : (
                          <div className="products__name">
                            <span className="products__name-text">{p.name}</span>
                            {p.minStock ? (
                              <span className="products__meta">Reorder at {p.minStock}</span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="products__price-column">
                        {editing === p.id ? (
                          <input
                            className="input--align-right"
                            type="number"
                            min={0}
                            step="0.01"
                            value={editPrice}
                            onChange={e => setEditPrice(e.target.value)}
                          />
                        ) : (
                          <span className="products__price">GHS {(p.price ?? 0).toFixed(2)}</span>
                        )}
                      </td>
                      <td>
                        {editing === p.id ? (
                          <input
                            className="input--align-right"
                            type="number"
                            min={0}
                            step="1"
                            value={editStock}
                            onChange={e => setEditStock(e.target.value)}
                          />
                        ) : (
                          <div className="products__stock">
                            <span className={`badge badge--${status}`}>{stockLabel}</span>
                            <span className="products__stock-count">{stockCount} on hand</span>
                          </div>
                        )}
                      </td>
                      <td>
                        {editing === p.id ? (
                          <div className="products__scan-input">
                            <input
                              value={editBarcode}
                              onChange={e => setEditBarcode(e.target.value)}
                              placeholder="Barcode"
                            />
                            <button
                              type="button"
                              className="button button--neutral button--small"
                              onClick={() => setScanMode('edit')}
                            >
                              Scan
                            </button>
                          </div>
                        ) : (
                          <span className="products__barcode">{p.barcode || '—'}</span>
                        )}
                      </td>
                      <td className="products__actions-column">
                        {editing === p.id ? (
                          <div className="products__action-group">
                            <button
                              type="button"
                              className="button button--primary button--small"
                              onClick={() => saveEdit(p.id!)}
                              disabled={busy}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="button button--ghost button--small"
                              onClick={() => setEditing(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="products__action-group">
                            <button
                              type="button"
                              className="button button--outline button--small"
                              onClick={() => beginEdit(p)}
                              disabled={busy}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="button button--danger button--small"
                              onClick={() => remove(p.id!)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <h3 className="empty-state__title">No products match your filters</h3>
              <p>Adjust the search or stock filter to see more items, or add a new product above.</p>
            </div>
          )}
        </div>
      </section>

      {/* Scanner modal mounts/unmounts as a separate component (stable hook order in Products) */}
      {scanMode && (
        <ScannerModal
          mode={scanMode}
          onValue={(value) => {
            if (scanMode === 'new') setBarcode(value)
            if (scanMode === 'edit') setEditBarcode(value)
          }}
          onClose={() => setScanMode(null)}
        />
      )}
    </div>
  )
}
